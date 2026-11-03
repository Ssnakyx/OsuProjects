"""Core tests: beatmap parsing, stacking, scoring and the shared web JSON."""
import os
import zipfile

import pytest

from conftest import write_osu
from src import mods as M
from src import webjson
from src.beatmap import compute_stack_heights, load_beatmap, stack_offset
from src.curves import compute_slider_path
from src.replay import Replay, ReplayFrame, load_replay
from src.scoring import compute_live_scores


# ── beatmap / timing ───────────────────────────────────────────────────────

def test_slider_duration_uses_green_line_and_uninherited_column(tmp_path):
    # red line 500ms/beat, then a green line at 2x SV on the same ms
    timing = "0,500,4,2,0,60,1,0\n1000,-50,4,2,0,60,0,0"
    p = write_osu(tmp_path / "m.osu", "100,100,1000,2,0,L|240:100,1,140", timing)
    s = load_beatmap(p).hit_objects[0]
    # 140px / (1.4*100*2) beats * 500ms = 250ms
    assert s.duration == pytest.approx(250.0)


def test_slider_velocity_is_clamped(tmp_path):
    timing = "0,500,4,2,0,60,1,0\n0,-1,4,2,0,60,0,0"      # absurd 100x SV
    p = write_osu(tmp_path / "m.osu", "100,100,1000,2,0,L|240:100,1,140", timing)
    s = load_beatmap(p).hit_objects[0]
    assert s.duration == pytest.approx(140 / (1.4 * 100 * 10) * 500)


def test_slider_path_is_extended_to_declared_length():
    path = compute_slider_path("L", [(0, 0), (50, 0)], 100)
    assert path[-1][0] == pytest.approx(100, abs=0.5)


def test_metadata_and_stack_leniency(tmp_path):
    p = write_osu(tmp_path / "m.osu", "1,1,1,1,0", extra_general="StackLeniency: 0.5")
    bm = load_beatmap(p)
    assert bm.stack_leniency == 0.5 and bm.format_version == 14


# ── stacking ───────────────────────────────────────────────────────────────

def test_stacked_circles(tmp_path):
    objs = "\n".join(f"200,200,{1000 + i * 100},1,0" for i in range(3))
    bm = load_beatmap(write_osu(tmp_path / "m.osu", objs))
    h = compute_stack_heights(bm, M.preempt_ms(9))
    assert h == [2, 1, 0]
    dx, dy = stack_offset(2, 32.0)
    assert (dx, dy) == pytest.approx((-6.4, -6.4))
    # Hard Rock: the playfield is flipped, so the offset points down in our space
    assert stack_offset(2, 32.0, hard_rock=True) == pytest.approx((-6.4, 6.4))


def test_far_apart_in_time_do_not_stack(tmp_path):
    objs = "200,200,1000,1,0\n200,200,9000,1,0"
    bm = load_beatmap(write_osu(tmp_path / "m.osu", objs))
    assert compute_stack_heights(bm, M.preempt_ms(9)) == [0, 0]


# ── scoring ────────────────────────────────────────────────────────────────

def test_fixture_scores(fixtures):
    bm = load_beatmap(str(fixtures / "test_map.osu"))
    alice = compute_live_scores(load_replay(str(fixtures / "replay_alice.osr")), bm)[-1]
    bob = compute_live_scores(load_replay(str(fixtures / "replay_bob.osr")), bm)[-1]
    assert (alice.n300, alice.n100, alice.n50, alice.nmiss) == (6, 0, 0, 0)
    assert alice.acc == 100.0
    assert bob.nmiss == 1 and bob.n300 + bob.n100 + bob.n50 == 5


def _replay(presses, mods=0):
    frames, last = [], 0
    for t, x, y in presses:
        frames.append(ReplayFrame(t - 20, x, y, 0))
        frames.append(ReplayFrame(t, x, y, 4))
        frames.append(ReplayFrame(t + 30, x, y, 0))
        last = t
    frames.append(ReplayFrame(last + 1000, 0, 0, 0))
    return Replay("", "p", mods, 0, frames)


def test_note_lock(tmp_path):
    # Two notes 150ms apart; the player clicks the 2nd one first (while the
    # 1st is still pending) — that click must not count.
    bm = load_beatmap(write_osu(tmp_path / "m.osu", "100,100,1000,1,0\n400,100,1150,1,0"))
    evs = compute_live_scores(_replay([(1000, 400, 100)]), bm)
    assert [e.judgment for e in evs[1:]] == [0, 0]


def test_early_click_is_a_miss(tmp_path):
    bm = load_beatmap(write_osu(tmp_path / "m.osu", "100,100,1000,1,0"))
    evs = compute_live_scores(_replay([(700, 100, 100)]), bm)   # 300ms early
    assert evs[-1].judgment == 0 and evs[-1].time == 700


def test_hit_on_stacked_position(tmp_path):
    objs = "200,200,1000,1,0\n200,200,1100,1,0"
    bm = load_beatmap(write_osu(tmp_path / "m.osu", objs))
    r = M.circle_radius(4)
    # first note is drawn (and must be hit) one stack step up-left
    off = r / 10
    evs = compute_live_scores(_replay([(1000, 200 - off, 200 - off), (1100, 200, 200)]), bm)
    assert [e.judgment for e in evs[1:]] == [300, 300]
    assert [e.time for e in evs[1:]] == sorted(e.time for e in evs[1:])


def test_dt_windows_are_in_song_time():
    w300, _, _ = M.hit_windows(8, M.DT)
    assert w300 == pytest.approx((80 - 48) * 1.5)


# ── web JSON / files ───────────────────────────────────────────────────────

def test_find_file_ci(tmp_path):
    (tmp_path / "Sub").mkdir()
    (tmp_path / "Sub" / "Audio.MP3").write_bytes(b"x")
    assert webjson.find_file_ci(str(tmp_path), "sub\\audio.mp3") == str(tmp_path / "Sub" / "Audio.MP3")
    assert webjson.find_file_ci(str(tmp_path), "missing.mp3") is None


def test_extract_osz_blocks_zip_slip(tmp_path, fixtures):
    osz = tmp_path / "m.osz"
    with zipfile.ZipFile(osz, "w") as z:
        z.write(fixtures / "test_map.osu", "map.osu")
        z.writestr("../evil.txt", "nope")
    paths = webjson.extract_osz(str(osz), str(tmp_path / "out"))
    assert len(paths) == 1 and not (tmp_path / "evil.txt").exists()


def test_json_payloads(fixtures):
    osu = str(fixtures / "test_map.osu")
    bm = load_beatmap(osu)
    rp = load_replay(str(fixtures / "replay_alice.osr"))
    m = webjson.map_json(bm, osu, 1, rp.beatmap_md5)
    assert m["md5Match"] and len(m["objects"]) == 7
    assert {o["k"] for o in m["objects"]} == {"c", "s", "p"}
    ev = webjson.events_json(rp, bm, 0)
    assert len(ev["events"]) == 6 and len(ev["windows"]) == 3
    assert webjson.replay_json(rp, 0)["player"] == "alice"
