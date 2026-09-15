# Fantasy Golf Draft

A website for our major championship draft. It runs a live snake draft, then scores each team from ESPN automatically.

- **Draft Room:** everyone drafts from their phone using their name and PIN, and the board updates for everyone within a few seconds.
- **Leaderboard:** standings plus a card for each team, refreshed every minute during play.
- **Side Bet:** the best single backup golfer wins, and a tie goes to the manager with the better second backup.
- **Rules:** built from each draft's settings.
- **Past Winners:** history brought over from the Google Sheet, plus every tournament finalized in the app.
- **Admin:** create a draft, set managers and PINs, set or randomize the draft order, load the field, undo picks, fix scores, and finalize.
- **Theme toggle:** switch between golf green and gold and the purple and mint look.

## Scoring rules built in

- Snake draft with 10 rounds. Rounds 9 and 10 are backups.
- A starter who withdraws **before his first tee shot** is replaced by the round 9 pick, then the round 10 pick, even if that backup has already started. Once a starter has teed off, no sub is allowed.
- Only 8 golfers play, and the best 6 scores count.
- CUT, WD, and DQ golfers get 80 for every round they missed.
- Tiebreakers compare the top 2, then top 4, top 6, and top 8 golfers.
- The admin can change the round, starter, counting, and penalty numbers for each draft.

---

## One-time setup

### 1. Put the code on GitHub

1. Go to github.com, click **New repository**, name it `golf-draft`, and set it to **Private**. Don't add a README.
2. Upload the code. Pick one:
   - **No tools:** on the new repo page, click **uploading an existing file**. Unzip `golf-draft.zip` and drag in everything inside the `golf-draft` folder, including the `.gitignore` file. Then commit.
   - **Git:** in the unzipped folder, run:
     ```
     git remote add origin https://github.com/YOUR-USERNAME/golf-draft.git
     git push -u origin main
     ```

### 2. Connect Netlify

1. Log in at app.netlify.com and choose **Add new project > Import an existing project > GitHub**.
2. Pick the `golf-draft` repo. Netlify reads `netlify.toml`, so leave the build settings blank.
3. Before deploying, open **Environment variables** and add:
   - `ADMIN_PASSWORD`: the password you'll use for the Admin page.
   - `SESSION_SECRET` (optional but recommended): any long random string. If you add it, changing your admin password won't log you out everywhere.
4. Click **Deploy**. After a minute you'll get a URL like `something.netlify.app`, which you can rename under **Site configuration > Change site name**.

Storage uses Netlify Blobs, which is built in, so you don't need a database to set up.

From now on, any change pushed to GitHub redeploys automatically.

---

## Running a tournament

1. **Admin > Create a new draft.** Choose the year and tournament and paste the ESPN leaderboard link. Click **Test link** to confirm the app can read it. Managers are copied from the last draft, so you only need to set PINs.
2. On the manage page:
   - **Randomize order**, or use the arrows to set the order by hand.
   - **Load field from ESPN** once ESPN posts the tee times, usually early in tournament week. If ESPN doesn't have the field yet, paste the names instead.
   - Click **Start draft**.
3. Send everyone the link. Each person taps **I'm a manager** and enters their PIN. Only the manager on the clock can pick, but the admin can pick for anyone and undo the last pick.
4. When the last pick is made, the draft switches to **Live** and the leaderboard takes over.
5. After Sunday, when the results are official, click **Finalize tournament** on the manage page. This freezes the scores and adds the winner, runner-up, draft positions, and side bet winner to Past Winners. If the side bet is still tied, pick the winner from the dropdown first.

### If ESPN is wrong or slow

Use **Fix a golfer's score** on the manage page. For example, if a golfer withdrew before teeing off and ESPN hasn't updated, set Status to WD and Teed off to No. The sub happens right away. Clear the fix once ESPN catches up.

On the leaderboard, admins also get a **Refresh from ESPN** button that skips the one-minute cache.

---

## About the ESPN data

The app uses ESPN's public golf feeds, the same data behind espn.com/golf/leaderboard. They're free but undocumented, so ESPN could change them without notice. The scoring code was tested against the 2026 U.S. Open results from our sheet, formatted the way ESPN's feed is structured. **Test it with a live tournament link before the first real draft.** Admin > Create draft > Test link shows whether the app can read the field. You can also open `/api/admin/espn-test?event=LINK` while logged in as admin to see exactly what the app pulls.

If something looks off, the parser is in `lib/espn.mjs`, and all scoring logic is in `lib/scoring.mjs`.

## Local testing (optional)

```
npm install
npm test                                        # scoring tests against the 2026 U.S. Open
node test/make-mock.mjs pre                     # build fake ESPN data
ADMIN_PASSWORD=test MOCK_ESPN_FILE=test/mock-espn-pre.json npm run dev
```
Open http://localhost:8888. The admin password is `test`.

## Project layout

```
public/            website (index.html, app.js, styles.css)
netlify/functions/ api.mjs, the server entry point Netlify runs
lib/               api routes, scoring engine, ESPN parser, storage
data/winners.mjs   past winners imported from the Google Sheet
test/              scoring tests and 2026 U.S. Open sample data
dev/server.mjs     local test server
```
