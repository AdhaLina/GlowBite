// GlowBite — Glow Scan edge function
// Receives a base64 food photo, asks Claude vision to identify foods,
// and returns which of GlowBite's known foods appear. The Anthropic API
// key lives here as a Supabase secret and never reaches the browser.
//
// Deploy: Supabase Dashboard → Edge Functions → create "glow-scan",
// paste this file, deploy. Then add the secret ANTHROPIC_API_KEY.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// Food identification is an easy vision task — Haiku 4.5 is ~5x cheaper than
// Opus and plenty capable here. Switch to "claude-opus-4-8" for max accuracy.
const MODEL = "claude-haiku-4-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: "server not configured: missing ANTHROPIC_API_KEY" }, 500);

  let payload: { image?: string; mediaType?: string; foods?: string[] };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const image = payload.image;
  const mediaType = payload.mediaType || "image/jpeg";
  const known = Array.isArray(payload.foods) ? payload.foods : [];
  if (!image) return json({ error: "no image provided" }, 400);

  const prompt =
    "You are a food + skincare-nutrition assistant for an app called GlowBite. " +
    "Look at this photo and identify every distinct food or ingredient visible. " +
    "Then invent 2 or 3 'glow meals' — real, easy recipes for healthy, glowing skin that " +
    "use mainly the foods in the photo (you may add a few common pantry items). " +
    "Here is GlowBite's list of known foods (match spelling exactly where possible):\n" +
    known.join(", ") +
    "\n\nReturn ONLY valid JSON with this exact shape:\n" +
    '{"foods":[{"name":"<food>","known":<true if it matches a GlowBite food above using that exact spelling, else false>,"confidence":<0-1>}],' +
    '"meals":[{"emoji":"<one food emoji>","name":"<short meal name>","time":"<e.g. 10 min>",' +
    '"skinBenefit":"<one sentence on how it helps skin glow>",' +
    '"ingredients":["<qty + item>", "..."],"steps":["<step>", "..."]}]}' +
    "\nList each food once. Keep recipes to 3-6 ingredients and 3-5 steps. " +
    "If you see nothing food-related, return empty arrays for both foods and meals.";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return json({ error: "vision request failed", status: r.status, detail: detail.slice(0, 300) }, 502);
    }

    const data = await r.json();
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

    // pull the JSON object out of the response text
    let parsed: any = { foods: [] };
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* leave empty */ }
    }
    const foods = Array.isArray(parsed.foods) ? parsed.foods : [];
    const meals = Array.isArray(parsed.meals) ? parsed.meals : [];
    return json({ foods, meals });
  } catch (e) {
    return json({ error: "unexpected error", detail: String(e).slice(0, 300) }, 500);
  }
});
