# Provisioning — getting the on-device runtime onto the phone

These scripts implement Phase 0 (validate) and Phase 2 (provision) of the plan.
They run on the **Pixel** inside Termux → proot Debian. Everything else (the
broker, the web UI, the Android app) lives elsewhere in this repo.

## TL;DR

```bash
# In Termux (installed from F-Droid):
pkg install -y git
git clone <this-repo-url> ~/mobile-agent          # or adb push the folder
bash ~/mobile-agent/provisioning/phase0-termux.sh # installs proot + debian

# Inside Debian:
proot-distro login debian
bash ~/provisioning/phase0-debian.sh              # THE GATE — prove it works
bash ~/provisioning/provision-debian.sh           # install the broker
PROFILE=mock bash ~/provisioning/run-broker.sh     # offline demo, no login
#   …or PROFILE=claude-max after `claude` + /login for the real engine
```

Open `http://127.0.0.1:8765/` in a browser (or the Android app) and you have the
full UI.

## The scripts

| Script | Where | What it does |
|---|---|---|
| `phase0-termux.sh` | Termux | Installs `proot-distro` + Debian, stages these scripts into the guest. |
| `phase0-debian.sh` | Debian | **The gate.** Installs node/npm/git + Claude Code, walks you through `/login`, then runs three smoke tests (Claude headless stream-json, Expo scaffold, Metro on localhost). |
| `provision-debian.sh` | Debian | Installs the toolchain + copies/clones the **broker** into `~/agent-broker`, `npm install`, creates `~/projects`, and verifies the broker boots with the mock engine. |
| `run-broker.sh` | Debian | Starts the broker. `PROFILE=mock` for offline; `PROFILE=claude-max` for the real engine. |
| `lib.sh` | both | Shared logging helpers. |

## The one manual step

Claude Code authenticates with your **Max subscription** via OAuth, which needs a
browser round-trip that can't be scripted:

```bash
claude          # then type:  /login
```

Open the printed URL on the phone, authorize, paste the code back. After that the
`claude-max` profile uses your flat subscription — no metered API billing.

## Snags & fixes (from the plan)

- **Metro file-watcher complains** → `WATCHMAN_DISABLE=1` (the scripts already set
  it) so Metro falls back to Node's watcher.
- **An npm package ships a glibc binary that won't run** → you're in Debian/glibc,
  so most `linux-arm64` prebuilts work. Packages that need on-device *compilation*
  → defer to EAS cloud build.
- **OAuth token expired mid-session** → re-run `claude` `/login`; the broker
  surfaces an `auth` error event so the UI can prompt you.

## Durability

Projects live in `~/projects` inside the guest. `git push` them to GitHub
routinely — that survives an app reinstall (plan decision #10).
