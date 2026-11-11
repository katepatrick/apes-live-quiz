# APES Live: a Kahoot-style quiz for your class

Students join on their phones with a 6-digit code (or by scanning a QR code), answer
timed questions, and compete on a live leaderboard. You project the host screen.

Included: **APES Unit 5, Land and Water Use (modules 24-34), 106 original questions**
with explanations, tagged by module.

## Run it on your laptop (same Wi-Fi as the students)

1. Install Node.js 18+ from nodejs.org (one time).
2. In this folder: `npm install` then `npm start`
3. The terminal prints two addresses. Open the **/host** one on the projector computer.
   Students open the "On your Wi-Fi" address on their phones (it looks like `http://192.168.x.x:3000`).
   Your computer and the phones must be on the same network (school guest Wi-Fi sometimes isolates devices; if so use the hosted option below).

## Put it online (works from anywhere, no same-network requirement)

Any host that runs Node and supports WebSockets works. Easiest free option, **Render.com**:

1. Put this folder in a GitHub repo (or upload it).
2. Render > New > Web Service > connect the repo. `render.yaml` fills in the settings.
3. In Render's Environment settings, set `HOST_KEY` to a password only you know. Without it, anyone with the host URL could start games.
4. Your URL will look like `https://apes-live-quiz.onrender.com`. Students go there; you go to `/host`.

Free plans sleep when idle, so the first load can take ~30-60 seconds. Open the host page a few minutes before class.

## Running a game

1. `/host` > pick modules, number of questions, time per question > **Create game**.
2. Put the code/QR on screen. Names appear as students join (click a name to remove it; "Lock joining" stops late joiners).
3. **Start**. After each question you see the answer distribution, the explanation, and the top 5.
   Space/Enter advances; "Skip to answer" ends a question early. It also ends on its own once everyone has answered.
4. At the end: podium, full results, and **Download results (CSV)** with each student's right/wrong per question.

**Scoring:** correct = 500-1000 points depending on speed, plus a streak bonus (+100 per consecutive correct, up to +500).
Calculation questions automatically get at least 30 seconds.

Students who lose connection or refresh rejoin automatically with their score.

## Adding more questions

Edit or copy `questions/apes-unit5.json`. Each question looks like:

```json
{ "module": "27", "q": "Question text?", "options": ["A", "B", "C", "D"], "answer": 0,
  "explain": "Shown after the question.", "time": 30 }
```

`answer` is the position of the correct option in `options` (0 = first). Use 2-4 options (2 = true/false).
`time` is optional. Any `.json` file in `questions/` shows up as a question set; restart the server after changes.

## Notes

- Game state lives in server memory: restarting the server ends running games. Nothing is stored about students.
- Student nicknames are shown on a shared screen, so you can remove anyone from the lobby.
- The questions were written from your module lecture slides. They are original wording; the publisher's slides are not included.
