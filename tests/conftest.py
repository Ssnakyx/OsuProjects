import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


@pytest.fixture(scope="session")
def fixtures(tmp_path_factory):
    """Synthetic map + two replays from tests/make_fixtures.py."""
    out = tmp_path_factory.mktemp("fixtures")
    subprocess.run([sys.executable, os.path.join(ROOT, "tests", "make_fixtures.py"), str(out)],
                   check=True, capture_output=True)
    return out


def write_osu(path, hit_objects, timing="0,500,4,2,0,60,1,0", extra_general="", diff=""):
    path.write_text(f"""osu file format v14

[General]
AudioFilename: audio.mp3
{extra_general}

[Metadata]
Title:T
Artist:A
Creator:c
Version:V

[Difficulty]
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
{diff}

[TimingPoints]
{timing}

[HitObjects]
{hit_objects}
""")
    return str(path)
