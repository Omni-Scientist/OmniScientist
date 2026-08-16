# Installing omnisci

```bash
cp -r omnisci ~/.claude/skills/
pip install -r ~/.claude/skills/omnisci/requirements.txt
```

The PDF is compiled with [tectonic](https://tectonic-typesetting.github.io/). Without it a run still produces
the `.tex` and stops there, saying so, and everything else works. To install it:

```bash
curl -fsSL https://drop-sh.fullyjustified.net | sh && sudo mv tectonic /usr/local/bin/
```

On ARM (Apple silicon, Graviton, Jetson) take the matching build from the project's releases instead, since
the wrong architecture fails with `Exec format error`:

```bash
V=0.17.0; A=$(uname -m)          # aarch64 or x86_64
curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$V/tectonic-$V-$A-unknown-linux-musl.tar.gz"   | sudo tar -xz -C /usr/local/bin tectonic
```

Anything on `PATH` is used, so the location is up to you.

Then start a Claude Code session and say what you want, for example "I have a folder of microscope images in
~/slides, make me a paper". The skill is selected by its description; you can also invoke it as `/omnisci`.

No API key is involved at any point: your own Claude Code session is the perceiver and the author.

## Checking the install

```bash
python3 ~/.claude/skills/omnisci/bin/case_cli.py inspect --dir <any folder of data>
```

It should print the modalities and labels it found. If it cannot find the evidence layer it will say so and
name the directory it looked in.
