# Autostarting the host with launchd (macOS)

The host is a foreground, operator-owned process: `ROVER_HTTP_PORT=4712 rover server` holds a
terminal window for as long as this machine is meant to lend its devices, and a closed window or a
reboot silently takes the machine out of the pool. `rover-server-agent` installs a launchd
**LaunchAgent** so the same command starts at login instead.

**The window is the smaller half of what it buys.** Every `rover` call — including the MCP server an
agent spawns — starts a daemon by itself when none is running, and that daemon deliberately has
`ROVER_LISTEN_PORT` and `ROVER_HTTP_PORT` cleared: a host that began listening for other machines
or for browsers as a side effect of `rover list` would be a change in exposure nobody chose (D40,
`src/daemon/connect.ts`). That daemon takes the socket, and a `rover server` typed afterwards finds
it already there and exits 1 — leaving a host that is up, holding devices, and reachable by nobody
with a browser. **A host that starts at login removes that race entirely, because it is always
first**, and every client then finds the reachable one.

It adds no supervision model of its own: the agent runs `rover server`, which is still the command
[`docs/MANUAL.md`](MANUAL.md) describes, with the same socket guard, the same environment
pass-through and the same signal forwarding. All it decides is *where that command runs* and *what
environment launchd hands it*.

macOS only — launchd is. On Linux the equivalent is a `systemd --user` unit running the same
command with `WorkingDirectory=` set to the checkout and the variables below as `Environment=`
lines; the script says so rather than half-working.

## Usage

```bash
rover-server-agent install   [<checkout>]   # write the agent and start it
rover-server-agent uninstall [<checkout>]   # stop it gracefully and remove the agent
rover-server-agent status    [<checkout>]   # loaded? whose host is on the socket? panel answering?
rover-server-agent restart   [<checkout>]   # stop it gracefully and start it again
rover-server-agent reload    [<checkout>]   # npm run reload, then restart — stops on a failed build
rover-server-agent logs      [<checkout>]   # tail this host's stdout + stderr
```

`<checkout>` is **the Rover checkout the host runs out of** — this repository — and defaults to the
current directory. It is not a project you test with; the host is one per machine and serves every
project registered on it.

The command ships in this package's `bin`, so a machine that has run `npm link` in the checkout
already has it on `PATH` next to `rover`. Without `npm link` it is `./bin/rover-server-agent` from
inside the checkout.

| What | Where |
| --- | --- |
| Agent | `~/Library/LaunchAgents/pl.smarttechbrewery.rover.host.<basename>.<hash8>.plist` |
| Logs | `~/Library/Logs/pl.smarttechbrewery.rover.host.<basename>.<hash8>.log` (+ `.error.log`) |
| Socket | `~/.rover/rover.sock`, unless `ROVER_SOCKET_PATH` said otherwise at install time |

`<hash8>` is the first eight characters of the sha256 of the checkout's realpath, so two clones
sharing a basename (`~/work/rover` and `~/oss/rover`) get distinct labels rather than one silently
overwriting the other. **There is still only one host per machine** (D18): the second one would lose
the socket, and `install` refuses a host it does not own rather than letting that happen — see below.

## What the agent carries, and why

### The plist carries the ports

launchd reads no rc files, so a job inherits none of the shell's environment — and two of these
variables are precisely the ones an autostarted daemon drops. They have to be stated somewhere, and
the plist is where. `install` reads them **from the shell you run it in** and writes exactly these
seven, and nothing else:

| Variable | What it does | Default |
| --- | --- | --- |
| `ROVER_HTTP_PORT` | serves the panel and its data to a browser | `4712` |
| `ROVER_HTTP_ADDRESS` | which interface that binds | loopback |
| `ROVER_LISTEN_PORT` | serves the surface to Rover clients on other machines | unset — off |
| `ROVER_LISTEN_ADDRESS` | which interface that binds | every interface |
| `ROVER_TLS_CERT` / `ROVER_TLS_KEY` | TLS material for either listener | unset |
| `ROVER_SOCKET_PATH` | the local socket, when the default is not wanted | `~/.rover/rover.sock` |

```bash
ROVER_HTTP_PORT=4712 rover-server-agent install       # the panel on http://127.0.0.1:4712
ROVER_LISTEN_PORT=7031 ROVER_TLS_CERT=… ROVER_TLS_KEY=… rover-server-agent install   # and the network
```

Changing any of them is `install` again with the new value set; the plist is rewritten and the host
restarted. **That works while the agent's own host is up** — `install` recognises it (the launchd pid
for this label, and the socket holder's ancestry, the same pair `status` uses) and reinstalls over it,
because the host holding the socket is the one the reinstall is about to stop. A host that is *not*
this agent's — one a client autostarted, or another checkout's agent — is still refused by name, since
losing the socket race to it would leave the agent crash-looping under `KeepAlive`.

**No secret is written into a plist, and there is no field where one could be.** A plist is
world-readable, so the list above is a fixed allowlist in the script — there is no `--env`, no
pass-through of your environment, and no file read into the dict. That is safe here because **the
host holds no secret at all** (D25): its credentials live in `~/.rover/users.json` and only ever as
hashes, issued with `rover users add` and revocable with `rover users revoke`. A port, an interface
and a path to a certificate are exposure choices, not credentials. `ROVER_HOST_TOKEN` is the one
Rover variable that *is* a secret, and it is a **client's** — it belongs on a machine that borrows a
device, never on a host — so it is not on the list and cannot be put there without editing the
script.

### `PATH` has to resolve `adb` and `idb_companion`, not just `node`

launchd starts a job with a minimal `PATH`, and the daemon spawns both of those programs **by
name**. A host whose `PATH` resolves only `node` starts perfectly cleanly and then fails every
single verb — up, holding devices, useful to nobody, which is the worst shape of failure this
project has.

So `install` resolves them on the installing machine and puts their real directories in the plist.
It does **not** use `command -v` for them, because the installing shell frequently cannot find them
either — an `adb` installed with Android Studio lives under `~/Library/Android/sdk/platform-tools`
and is on nobody's `PATH` by default. `scripts/device-tool-dirs.mjs` asks this checkout's **own**
search instead (#171, D32), so the plist names the same binary the daemon would have picked.

Which of the two this actually rescues, since both searches look in more than `PATH`:

- **`adb` is already found without it** — from `ROVER_ADB_PATH`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`
  or the platform's standard SDK root (`src/backends/android/adb-locations.mjs`). Putting it on
  `PATH` is belt-and-braces, and it means a bare `adb` in a project's hook commands also resolves.
- **`idb_companion` is the one that needs it.** The copy `rover doctor --fix` unpacks under
  `~/.rover` is found with no `PATH` at all, but a companion you installed yourself is found on
  `PATH` and nowhere else (`src/backends/ios-simulator/idb-companion-locations.mjs`).

`node`, `npm` and `git` are resolved with `command -v` and their directories added, along with
`~/.local/bin` and the usual system ones — so an Intel Homebrew (`/usr/local`), an Apple Silicon one
(`/opt/homebrew`) and a node under nvm/asdf/fnm all work without editing anything. Anything *else* a
project hook needs from a login shell — a proxy, `JAVA_HOME`, an extra API key — is still not
inherited, and belongs in that project's hook file rather than here.

### `install` refuses while a host it does not own holds the socket

```
rover-server-agent: a Rover host (pid 84832) that this agent does not own is already serving this machine, up 43s.
  The agent would lose the socket to it and crash-loop under KeepAlive, so nothing was installed.
  Stop that host -- kill 84832 -- and run install again. …
```

Under `KeepAlive`, losing the socket race is not an error message: it is a host that exits 1 and is
restarted every thirty seconds forever, with a panel nobody can explain the absence of. The check is
**the one `rover server` already makes** — `src/daemon/host-on-socket.ts`, reached from the shell
through `scripts/host-on-socket.mjs` — rather than a second one in bash that could disagree with it.

**The agent's own host is deliberately not refused**, and `install` prints that it is reinstalling
over it instead:

```
rover-server-agent: reinstalling over this agent's own host (pid 84832, up 43s)
```

There is no race to lose in that case — the host on the socket is the one the `launchctl bootout` a
few lines further down is about to stop — and refusing it would break the only documented way to
change a port, an address or the TLS pair. The remedy the refusal suggests would not work there
either: `KeepAlive` is true, so killing the daemon has launchd put a replacement straight back on
the socket. The two are told apart by the launchd pid for this label and the socket holder's
ancestry, the same pair `status` uses below and for the same reason.

**It is never `rover status`.** That is a client call, so it *autostarts* a daemon when none is
running — with the ports cleared — which is exactly the damage this guard exists to prevent. Using
it as a probe would manufacture the problem.

### `status` tells this agent's host apart from a portless one

That is the failure this tool exists around, and a status that said `running` for both would be
worse than no status at all:

```
label:    pl.smarttechbrewery.rover.host.rover.93ea5d2a
checkout: /Users/me/Projects/rover
plist:    /Users/me/Library/LaunchAgents/pl.smarttechbrewery.rover.host.rover.93ea5d2a.plist
url:      http://127.0.0.1:4712/
socket:   /Users/me/.rover/rover.sock
launchd:  state = running
          pid = 89090
          last exit code = (never exited)
host:     this agent's host, pid 89101, up 1m 11s
panel:    answering on http://127.0.0.1:4712/
```

and the shape you are looking for when the panel is dark:

```
launchd:  state = spawn scheduled
          last exit code = 0
host:     NOT this agent -- pid 85595 holds the socket.
          A daemon a client autostarted has no ports at all (D40), so it serves
          no browser and no other machine. Stop it (kill 85595), then: restart
panel:    no answer on http://127.0.0.1:4712/
```

**The two pids are compared by ancestry, not by equality.** `rover server` is a wrapper: it spawns
the daemon as a child and stays attached to forward the signals, which is what makes a graceful stop
release the leases. So the pid launchd holds (`89090` above) and the pid on the socket (`89101`) are
*meant* to differ by one generation, and comparing them directly reports this agent's own host as a
stranger's — which it did, on a real host, while this was being written.

### Readiness is `GET /` on `ROVER_HTTP_PORT`, everywhere

`install`, `restart` and `reload` all end by waiting for that one request to answer, and `status`
asks it once. It is the whole of what an operator installed this for in one probe: the process is
up, it kept the port, and the page is there — the host serves the panel from the listener that also
serves `/rpc`, so there is nothing else to check. The route answers before the token gate by design
(D29), so no credential is involved in a liveness check, and `HEAD /` is accepted for the same
reason if you would rather write that one.

**It is never `rover status`**, for the reason the install guard is not: it would autostart a daemon
and create the unreachable host. The waiting is `curl --retry --retry-connrefused`, a poll on a
condition with a bound, because nothing in this repository sleeps (`ai/RULES.md` §2).

### `reload` builds first, and stops if the build fails

```bash
rover-server-agent reload      # npm run reload, in the foreground, then restart
```

`npm run reload` is `npm install && npm run panel:build`, and it is the **single definition** of
that chain — the script has no second copy of it, exactly as Swarm's `reload`/`reload:all` are the
one definition of theirs. It runs in the foreground, so a `vite` error arrives on your terminal
rather than in a launchd log, and **nothing is restarted if it fails**: the host keeps serving the
build it already had.

```
rover-server-agent: 'npm run reload' failed in /Users/me/Projects/rover -- nothing was restarted,
and the host is still serving what it had
```

### A graceful stop releases the leases

`uninstall` and `restart` both stop the host with `SIGTERM` (`launchctl bootout` and
`launchctl kickstart -k`). That signal reaches `rover server`, which forwards it to the daemon
(`src/cli/_shared/foreground.ts`), which runs its own shutdown — and that shutdown **ends every
lease it still holds and restores the devices** (D9 as amended): a recording stopped, the app
stopped, airplane mode off, wifi back on, the project's services and teardown run.

**That was measured, not assumed** (#294): against `emulator-5554` on API 37, a lease that had
turned airplane mode on and a graceful stop of the host left the device in airplane mode
indefinitely, because the shutdown only swept leases that had *expired*. `src/daemon/listen.ts` now
releases live ones too, through the same path a caller's own release takes, and the same check runs
clean. It matters much more under launchd than it did before: a foreground host was stopped by
somebody who was looking at it, and this one is stopped at logout, at reboot and on every `reload`.

**The plist states its own `ExitTimeOut` (60s) rather than inheriting one.** That is how long
launchd waits after the `SIGTERM` before `SIGKILL`, and the default is system-defined — 20s on
macOS today, a number nobody here chose. The shutdown above is not instantaneous: it bounds the
restorations at 10s and the archive sweep at 10s (`RESTORE_SETTLE_TIMEOUT_MS` and
`SWEEP_SETTLE_TIMEOUT_MS` in `src/daemon/listen.ts`), awaits them in sequence and then stops the
backends, so 60 sits comfortably past the worst case they add up to. No stop measured here has come
close — this is against the default, not against an observed overrun — but the sweep is the sharp
end: a `SIGKILL` partway through its `rm` leaves a run directory holding a subset of what its lease
wrote, and logout, reboot and every `reload` now run that path.

## Gotchas

- **One host per machine, so one agent.** Running `status`, `restart`, `reload`, `logs` or
  `uninstall` from an unrelated directory refuses and names the checkout the installed agent runs
  for, rather than telling you nothing is installed.
- **A client can still win the socket while the agent is down.** The agent is first at login, which
  is what removes the race in practice — but stop the host by hand, run any `rover` command, and a
  portless daemon takes the path; the agent then crash-loops behind it. That is exactly the shape
  `status` prints above: stop the pid it names, then `restart`.
- **The panel has to have been built.** A host whose `panel/dist` is missing answers one plain
  sentence naming `npm run panel:build` instead of a page — `rover-server-agent reload` is that
  build plus a restart.
- **The browser needs a credential.** `rover users add <name>` on this machine prints one, once.
  The agent carries no credential of any kind (see above), and adding a user needs no restart: the
  store is re-read on every request.
- **`ThrottleInterval` is 30 seconds**, with `KeepAlive` — so a host that dies is restarted without
  a genuine failure becoming a hot loop. `status`'s `last exit code` is what tells the two apart.
- **Logs are kept on `uninstall`.** The plist goes; `~/Library/Logs/<label>.log` and its
  `.error.log` stay where they were.
