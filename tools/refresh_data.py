"""Recover the exact real-source snapshot, rejecting unrecognized bytes."""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import urllib.request
import pandas as pd

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "data/manifest.json").read_text())
downloaded = {}
for source in manifest["sources"]:
    with urllib.request.urlopen(source["url"], timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise ValueError("Upstream checksum mismatch: " + source["name"])
    downloaded[source["name"]] = pd.read_csv(BytesIO(data))
    print("Verified", source["name"])

hospital = downloaded.pop("hospital.csv")
indicators = ["Daily hospital occupancy", "Daily ICU occupancy",
              "Daily hospital occupancy per million", "Daily ICU occupancy per million"]
period = manifest["snapshot_period"]
hospital = hospital[hospital.entity.isin(manifest["countries"]) & hospital.indicator.isin(indicators)
                    & hospital.date.between(period["start"], period["end"])]
vaccination = pd.concat(downloaded.values(), ignore_index=True)
vaccination = vaccination[vaccination.date.between("2020-12-01", period["end"])]
outputs = {"hospital_occupancy.csv": hospital, "vaccinations.csv": vaccination}
for name, frame in outputs.items():
    data = frame.to_csv(index=False).encode()
    if hashlib.sha256(data).hexdigest() != manifest["local_files"][name]:
        raise ValueError("Recovered snapshot differs from bundled snapshot: " + name)
    (root / "data/raw" / name).write_bytes(data)
print("Recovered snapshot matches the bundled data.")
