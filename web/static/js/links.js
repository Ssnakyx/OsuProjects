/* Parse whatever the user pastes into the "load from a link" box.

   Returns one of
     { kind: "score",   id, ruleset }   osu.ppy.sh/scores/123 · /scores/osu/123
     { kind: "map",     sid?, bid? }    beatmapset / beatmap links, bare ids
     { kind: "osr",     url }           a direct https link to a .osr file
     null                               nothing we understand
   Pure function — no DOM, no network (tested with node). */

const RULESETS = new Set(["osu", "taiko", "fruits", "mania"]);

export function parseLink(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  // Bare number → a beatmap (difficulty) id, the id people copy most.
  // "s123" / "b123" are handy explicit forms.
  let m = text.match(/^([sb])?\s*#?(\d{1,10})$/i);
  if (m) {
    const id = +m[2];
    if (!id) return null;
    return (m[1] || "b").toLowerCase() === "s" ? { kind: "map", sid: id } : { kind: "map", bid: id };
  }

  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(text) ? text : "https://" + text); }
  catch (e) { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;

  const path = url.pathname.replace(/\/+$/, "");
  if (/\.osr$/i.test(path)) return { kind: "osr", url: url.href.replace(/^http:/, "https:") };

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "osu.ppy.sh" && host !== "lazer.ppy.sh") return null;
  const seg = path.split("/").filter(Boolean);

  // /scores/{id}  ·  /scores/{ruleset}/{id}
  if (seg[0] === "scores") {
    if (seg.length >= 3 && RULESETS.has(seg[1]) && /^\d+$/.test(seg[2]))
      return { kind: "score", id: +seg[2], ruleset: seg[1] };
    if (/^\d+$/.test(seg[1] || "")) return { kind: "score", id: +seg[1], ruleset: null };
    return null;
  }

  // /beatmapsets/{sid}#osu/{bid}  ·  /beatmapsets/{sid}/discussion/{bid}/…
  if (seg[0] === "beatmapsets" && /^\d+$/.test(seg[1] || "")) {
    const out = { kind: "map", sid: +seg[1] };
    const h = url.hash.match(/^#(?:osu|taiko|fruits|mania)\/(\d+)/);
    if (h) out.bid = +h[1];
    else if (seg[2] === "discussion" && /^\d+$/.test(seg[3] || "")) out.bid = +seg[3];
    return out;
  }
  // /beatmaps/{bid}  ·  /b/{bid}  ·  /s/{sid}  ·  /p/beatmap?b=  (legacy)
  if ((seg[0] === "beatmaps" || seg[0] === "b") && /^\d+$/.test(seg[1] || ""))
    return { kind: "map", bid: +seg[1] };
  if (seg[0] === "s" && /^\d+$/.test(seg[1] || "")) return { kind: "map", sid: +seg[1] };
  const b = url.searchParams.get("b"), s = url.searchParams.get("s");
  if (b && /^\d+$/.test(b)) return { kind: "map", bid: +b };
  if (s && /^\d+$/.test(s)) return { kind: "map", sid: +s };
  return null;
}
