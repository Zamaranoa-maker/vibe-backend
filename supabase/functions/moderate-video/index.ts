// ============================================================================
// moderate-video — مراجعة آلية للفيديو قبل النشر (Supabase Edge Function)
// fail-closed: أي خطأ يخلي الفيديو pending ومش بيظهر
// NOTE: OpenAI moderation is a PAID service. In Phase 0 this function
//       degrades gracefully to local text_check (from DB) when no API key.
// ============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);
const KEY = Deno.env.get('OPENAI_API_KEY') || '';

async function moderate(input: unknown) {
  const r = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'omni-moderation-latest', input }),
  });
  if (!r.ok) throw new Error('moderation_api_' + r.status);
  return (await r.json()).results[0];
}

Deno.serve(async (req: Request) => {
  try {
    const jwt = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user } } = await sb.auth.getUser(jwt);
    if (!user) return new Response('unauthorized', { status: 401 });

    const { videoId, frames } = await req.json();
    if (!Number.isFinite(videoId) ||
        !Array.isArray(frames) || frames.length > 3 ||
        frames.some((f: unknown) => typeof f !== 'string' || f.length > 400_000))
      return new Response('bad input', { status: 400 });

    const { data: v } = await sb.from('videos')
      .select('id, creator_id, caption, status').eq('id', videoId).single();
    if (!v || String(v.creator_id) !== user.id || v.status !== 'pending')
      return new Response('forbidden', { status: 403 });

    let reason: string | null = null;
    let reportReason = 'other', priority = 3, detail = '';

    if (KEY) {
      try {
        const checks = [
          ...(v.caption ? [moderate(v.caption)] : []),
          ...(frames as string[]).map((f) => moderate([{ type: 'image_url', image_url: { url: f } }])),
        ];
        for (const res of await Promise.all(checks)) {
          if (!res.flagged) continue;
          reason = 'auto_flagged';
          const c = res.categories;
          if (c['sexual/minors']) { reportReason = 'child_safety'; priority = 1; }
          else if (c['sexual'] && priority > 2) { reportReason = 'sexual'; priority = 2; }
          else if ((c['violence/graphic'] || c['violence']) && priority > 2) { reportReason = 'violence'; priority = 2; }
          else if ((c['self-harm'] || c['self-harm/intent'] || c['self-harm/instructions']) && priority > 2)
            { reportReason = 'self_harm'; priority = 2; }
          else if ((c['hate'] || c['harassment']) && priority > 3) { reportReason = 'hate'; }
        }
      } catch (_) { reason = 'check_failed'; detail = 'تعذّر الفحص الآلي'; }
    } else {
      // Phase 0: فحص نصي مجاني من قاعدة البيانات بدل OpenAI
      const { data: tc } = await sb.rpc('text_check', { t: v.caption || '' });
      if (tc === 'block') { reason = 'blocked_word'; detail = 'كلمة ممنوعة'; }
      else if (tc === 'review') { reason = 'word_review'; detail = 'كلمة تحتاج مراجعة'; }
    }

    // أول 3 فيديوهات للحساب الجديد = مراجعة يدوية
    if (!reason) {
      const { count } = await sb.from('videos').select('id', { count: 'exact', head: true })
        .eq('creator_id', v.creator_id).eq('status', 'approved');
      if ((count ?? 0) < 3) { reason = 'new_creator'; detail = 'مبدع جديد: مراجعة أولى'; }
    }

    if (!reason) {
      await sb.from('videos').update({ status: 'approved' }).eq('id', videoId);
      return Response.json({ status: 'approved' });
    }

    await sb.from('videos').update({ status: 'under_review' }).eq('id', videoId);
    await sb.from('reports').insert({
      reporter_id: null, target_type: 'video', target_id: String(videoId),
      target_owner: v.creator_id, reason: reportReason, priority,
      details: `[${reason}] ${detail}`.slice(0, 500),
    });
    return Response.json({ status: 'under_review' });
  } catch (e) {
    console.error(e);
    return new Response('error', { status: 500 }); // يفضل pending، آمن
  }
});
