// node tests/links.test.mjs — checks the link parser used by the web UI.
import assert from "node:assert/strict";
import { parseLink } from "../web/static/js/links.js";

const cases = [
  ["75", { kind: "map", bid: 75 }],
  ["s1", { kind: "map", sid: 1 }],
  ["https://osu.ppy.sh/beatmapsets/1#osu/75", { kind: "map", sid: 1, bid: 75 }],
  ["osu.ppy.sh/beatmapsets/39804", { kind: "map", sid: 39804 }],
  ["https://osu.ppy.sh/beatmaps/129891?mode=osu", { kind: "map", bid: 129891 }],
  ["https://osu.ppy.sh/b/75", { kind: "map", bid: 75 }],
  ["https://osu.ppy.sh/s/1", { kind: "map", sid: 1 }],
  ["https://osu.ppy.sh/p/beatmap?b=75", { kind: "map", bid: 75 }],
  ["https://osu.ppy.sh/scores/1234567890", { kind: "score", id: 1234567890, ruleset: null }],
  ["https://osu.ppy.sh/scores/osu/4100000000", { kind: "score", id: 4100000000, ruleset: "osu" }],
  ["https://cdn.example.com/replays/abc.osr?x=1", { kind: "osr", url: "https://cdn.example.com/replays/abc.osr?x=1" }],
  ["https://example.com/page", null],
  ["hello world", null],
  ["0", null],
  ["", null],
];
for (const [inp, want] of cases) assert.deepEqual(parseLink(inp), want, inp);
console.log(`links: ${cases.length} cases ok`);
