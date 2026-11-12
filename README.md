# reach

A private dashboard for your own machines. From it you browse and edit their files, upload and download, run commands and start saved scripts, from your PC or your phone, whatever network each machine is on.

There are two programs:

- **The dashboard program** opens your dashboard. It is protected by your password and is the only thing that can control machines.
- **Client programs** are downloaded from your dashboard. Run one on a computer and that computer appears on your dashboard. It runs in the background with no window, starts again whenever the computer starts, and on Windows sits as an icon next to the clock. That is all a client can do: it cannot open the dashboard or control anything, and it holds nothing secret.

No VPN, no port forwarding, no account. Everything is end-to-end encrypted.

## Quick start

**1. Get the dashboard program** on your main computer:

| System | Download |
| --- | --- |
| Windows | [reach-dashboard-windows-x64.exe](https://github.com/antoniolox1721/reach/releases/latest/download/reach-dashboard-windows-x64.exe) |
| Linux | [reach-dashboard-linux-x64](https://github.com/antoniolox1721/reach/releases/latest/download/reach-dashboard-linux-x64) or [reach-dashboard-linux-arm64](https://github.com/antoniolox1721/reach/releases/latest/download/reach-dashboard-linux-arm64) |
| Mac (Apple silicon) | [reach-dashboard-macos-arm64](https://github.com/antoniolox1721/reach/releases/latest/download/reach-dashboard-macos-arm64) |

On Linux and Mac make it runnable first: `chmod +x reach-dashboard-*`. The programs are not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time: choose *More info*, then *Run anyway*. On a Mac, right-click the file and choose *Open*.

**2. Start it.** Your browser opens the dashboard at `http://127.0.0.1:7700`. Choose **Create my dashboard** and pick a password. You type that password every time you open the dashboard.

**3. Add computers.** Under **Add a machine**, download the **client program** for Windows or Linux. Copy it to a computer and run it there. The computer appears on your dashboard a few seconds later, with no questions asked, and stays on it (see [the client in the background](#the-client-in-the-background)). You can reuse the same client file on as many computers as you like, including the one the dashboard is on.

**4. Or add only this computer for now.** **Add this computer** puts the dashboard's own computer in the list, but only for as long as the dashboard program's window is open. Run the client program on it instead to keep it reachable.

**5. Use it from your phone.** Under **Add a machine**, choose **Show QR code** and scan it with your phone. The phone opens the dashboard at <https://antoniolox1721.github.io/reach/> and asks you to choose a password for the phone. From then on that page is your dashboard on the phone.

### Everything prepared in one go

Instead of steps 2 to 4 you can let the program prepare a kit. In a terminal, in the folder where the dashboard program is:

```
reach-dashboard-windows-x64.exe kit
```

It creates your dashboard and writes `reach-client-windows-x64.exe` and `reach-client-linux-x64` into the folder. Then start the dashboard program: it only asks you to choose your password. Run a client program on any computer and it appears by itself.

Until you have chosen the password, the new dashboard key sits unprotected in `~/.reach/config.json` on that computer, so start the dashboard program right after making the kit. Only the page that the program opens itself can collect it.

### The client in the background

Running a client program does three things and then returns at once:

1. It copies itself to `~/.reach/bin` (on Windows `C:\Users\you\.reach\bin`), so the downloaded file or USB stick is no longer needed.
2. It registers itself to start whenever you log in to the computer.
3. It starts in the background, with no window.

**On Windows** it shows an icon next to the clock (bottom right; it may be behind the `^` arrow). Right-click it for:

- **Disable / Enable**: take this computer off your dashboard, or put it back. It stays disabled across restarts.
- **Start with Windows**: tick or untick.
- **Quit**: stop it until the next start.

**On Linux** there is no icon. Use `~/.reach/bin/reach stop` to stop it and `~/.reach/bin/reach autostart off` to keep it from starting at login. Starting at login uses the desktop's autostart folder, so a server without a desktop session needs its own service entry running `~/.reach/bin/reach --background`.

The dashboard program is different on purpose: it is an ordinary window that you open when you want your dashboard and close when you are done.

### Macs, Android phones and other machines

Client programs cannot be made for Macs (stamping breaks their signature) or phones. Those join with a one-time code instead:

- **Mac**: start the dashboard program, and on the page choose *Only add this computer to a dashboard I have elsewhere*. It shows a code. On your dashboard choose *Add a machine* and type the code.
- **Android** (to reach the phone's own files): install [Termux](https://termux.dev) from F-Droid, then:

  ```
  pkg install nodejs git
  termux-setup-storage
  npx github:antoniolox1721/reach pair
  ```

  Type the code it shows into your dashboard. `termux-setup-storage` makes photos and downloads available under `~/storage/shared`. Run `termux-wake-lock` so Android does not put it to sleep.
- **Any machine with Node.js 18+ and git**: `npx github:antoniolox1721/reach pair`.

iPhones can use the dashboard but cannot be a machine on it.

## The dashboard

- **My machines**: every machine that is online. Tap one to open it.
- **Files**: browse folders, tap a file to open (text and images), edit and save, download, rename or delete. *Upload* sends files from the device you are holding. *Open terminal here* is in a folder's `⋯` menu.
- **Terminal**: type a command, see the output live. `cd` works. While a program runs you can type input for it or press *Stop*. Jobs keep running if you close the page or lose signal; tap a job under *Jobs* to pick its output back up.
- **Scripts**: save commands you run often (name, command, folder) and start them with one tap. They are stored on the machine they belong to.
- **Lock**: closes the dashboard until the password is typed again.

## Commands

Double-clicking is enough. From a terminal:

```
reach                 dashboard program: open the dashboard (stays in this window)
                      client program: put this machine on the dashboard, in the background,
                      now and every time the computer starts
reach stop            stop the background client
reach autostart on|off   whether the client starts with the computer
reach kit [folder]    prepare a new dashboard for this computer plus Windows and Linux client programs
reach pair            show a one-time code to add this machine to a dashboard, then stay online
reach client          stay online without opening the dashboard (after this machine was added)
reach name <name>     rename this machine

--name <name>         name for this machine (saved)
--broker <wss url>    use your own MQTT-over-WebSocket relay (saved)
--port <number>       port for the local dashboard page (default 7700)
--no-open             do not open the browser
--foreground          client program: stay in this terminal instead of going to the background
--no-qr               do not print QR codes
```

`reach` here means the downloaded program, or `npx github:antoniolox1721/reach`.

Machines added with a pairing code (`reach pair`, Macs, Termux) are reachable only while that program stays open; client programs handle this by themselves.

## Security

Whoever opens your dashboard can read your files and run commands on your machines, so this is the part to understand.

- **Your dashboard has a key pair.** The private half, the *dashboard key*, is created in your browser when you create the dashboard. It is stored on that device only, encrypted with your password (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM). The password is never sent anywhere.
- **Clients only know the public half.** A client program is the ordinary program with your dashboard's public address attached. Each machine makes its own key pair, and everything between the dashboard and that machine is encrypted with a key that only the two of them can compute (ECDH P-256, AES-256-GCM). A machine obeys only requests encrypted with that key, so only a device holding the dashboard key can control it. Someone who gets hold of a client program, or of a machine running one, cannot control your other machines or read their traffic.
- **The relay sees only ciphertext.** It can tell that devices are online and how much they send, and it can block traffic. It cannot read or forge anything. Recorded requests cannot be replayed: each session numbers its requests and machines drop repeats.
- **The dashboard page is not the access.** The page on your computer is served to that computer only, and it refuses requests from other websites. The public page at `antoniolox1721.github.io` is the same empty page: it has no accounts and no machine list, and does nothing until a device supplies its password-locked dashboard key.
- **Pairing codes** are random, used once, and only prove that you are looking at the machine's screen.

What you need to do:

- Choose a good password. It is all that stands between someone using your computer or phone and all your machines.
- The **phone QR code contains the dashboard key**. Show it only to your own phone. Anyone who photographs it has full access.
- Run client programs only on machines you are happy to have on your dashboard, and only client programs you downloaded from your own dashboard: a machine obeys whichever dashboard its client program belongs to.
- A leaked client file lets a stranger make *their* machine show up in your list (they still cannot control anything). Machines you have not opened before on a device are marked **new** and ask before opening: do not open ones you do not recognise.
- If the dashboard key may have leaked (lost phone with a weak password, photographed QR code), choose *Forget this device* on every device, create a new dashboard, and download new client programs for your machines. A machine switches dashboards when you run a new client program on it.
- The public page is served from this GitHub repository. If you would rather not depend on that for your phone, fork the repository and host the `docs/` folder yourself.

## Limits

- Commands run through the machine's shell (`cmd.exe` on Windows, `$SHELL` elsewhere), one process per command. Full-screen terminal programs such as `vim` or `htop` do not work.
- The default relay is the free public HiveMQ broker. It is fine for commands and ordinary files (a few hundred KB/s to a few MB/s), has no uptime guarantee, and connecting occasionally takes several seconds. For heavy use point every program at your own relay with `--broker wss://...` (any MQTT broker with WebSocket support, for example Mosquitto).
- Downloads are assembled in the browser's memory, so very large files (many hundreds of MB) are better moved another way. Files up to 2 MB can be opened and edited in the page.
- The terminal keeps the last 1 MB of each job's output and remembers the last 30 jobs until the program is restarted.
- The dashboard key lives in the browser's storage for that page. Clearing the browser's site data removes it; keep the dashboard on a second device (your phone) so you are not locked out.

## Development

```
git clone https://github.com/antoniolox1721/reach
cd reach
npm install
npm test        # starts real programs and drives them through the real relay
node reach.js   # dashboard program from source
node build.mjs  # standalone executable for this OS in dist/ (REACH_BIN=dist/... npm test checks it)
```

Layout: `reach.js` is the program (dashboard server and client). `docs/` is the dashboard page, served by the program and by GitHub Pages; `docs/core.js` holds the encryption and protocol and is shared by both.

Pushing a tag such as `v0.2.0` makes GitHub Actions build the executables for Windows, Linux and Mac and attach them to a release.

MIT license.
