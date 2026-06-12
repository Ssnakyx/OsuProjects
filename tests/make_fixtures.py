"""Generate a tiny synthetic beatmap + two replays that play it.

Usage:  python tests/make_fixtures.py [outdir]
Creates outdir/test_map.osu, outdir/replay_a.osr, outdir/replay_b.osr
"""
import hashlib
import os
import sys
from datetime import datetime, timezone

from osrparse import GameMode, Key, Mod, Replay, ReplayEventOsu

OUT = sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures"
os.makedirs(OUT, exist_ok=True)

OSU = """osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 0

[Metadata]
Title:Test Song
Artist:Test Artist
Creator:fixture
Version:Normal
BeatmapSetID:0

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:7
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1

[Events]
0,0,"bg.jpg",0,0

[TimingPoints]
0,500,4,2,0,60,1,0

[HitObjects]
100,100,1000,5,0,0:0:0:0:
200,150,1500,1,0,0:0:0:0:
300,200,2000,1,0,0:0:0:0:
150,250,2500,2,0,L|350:250,1,140
400,100,3500,1,0,0:0:0:0:
256,192,4000,12,0,5000,0:0:0:0:
120,300,5500,5,0,0:0:0:0:
"""

osu_path = os.path.join(OUT, "test_map.osu")
with open(osu_path, "w") as f:
    f.write(OSU)
md5 = hashlib.md5(open(osu_path, "rb").read()).hexdigest()
print("map md5:", md5)

# Object times/positions a cursor must visit (slider = head only)
HITS = [(1000, 100, 100), (1500, 200, 150), (2000, 300, 200),
        (2500, 150, 250), (3500, 400, 100), (5500, 120, 300)]


def make_replay(name: str, jitter: list, miss_idx: int = -1) -> str:
    events = []
    t_prev = 0
    for n, (t, x, y) in enumerate(HITS):
        terr = jitter[n % len(jitter)]
        if n == miss_idx:
            # Arrive late and never press — a guaranteed miss
            press_t = t + 300
            events.append(ReplayEventOsu(press_t - t_prev, x + 200, y, Key(0)))
            t_prev = press_t
            continue
        press_t = t + terr
        move_t = press_t - 80
        events.append(ReplayEventOsu(move_t - t_prev, float(x), float(y), Key(0)))
        events.append(ReplayEventOsu(80, float(x), float(y), Key.K1))
        events.append(ReplayEventOsu(40, float(x), float(y), Key(0)))
        t_prev = press_t + 40
    events.append(ReplayEventOsu(7000 - t_prev, 256.0, 192.0, Key(0)))

    r = Replay(
        mode=GameMode.STD, game_version=20230101, beatmap_hash=md5,
        username=name, replay_hash="", count_300=5, count_100=1, count_50=0,
        count_geki=0, count_katu=0, count_miss=1 if miss_idx >= 0 else 0,
        score=1000, max_combo=6, perfect=False, mods=Mod.NoMod,
        life_bar_graph=None, timestamp=datetime.now(timezone.utc),
        replay_data=events, replay_id=0, rng_seed=None,
    )
    path = os.path.join(OUT, f"replay_{name}.osr")
    r.write_path(path)
    return path


a = make_replay("alice", jitter=[-5, 8, 2, -12, 20, 4])
b = make_replay("bob",   jitter=[30, -45, 60, 15, -80, 95], miss_idx=4)
print("replays:", a, b)
