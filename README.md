# Our Budget

A private budgeting and bill-splitting app for two people. You add it to your iPhone home screens like a regular app.

- **Your data is end-to-end encrypted.** Each expense is encrypted on your phone with AES-256-GCM, using a key made from your shared passphrase, before it's saved or synced. Supabase only ever stores scrambled data.
- **Nothing gets linked.** No cards, no banks, no Splitwise. You type expenses in or scan a receipt.
- **Receipt scanning happens on your phone.** The photo never gets uploaded anywhere.
- **Face ID unlock.** You enter the passphrase once on each phone and use Face ID after that (needs iOS 18 or newer).
- **Splitting is built in.** Mark each expense as shared (50/50 or a custom split) or personal. The app keeps a running "who owes whom" total and lets you record payments to settle up.
- **USD and INR.** Enter expenses in either currency. Budgets and totals show in USD, using the daily rate or a fixed rate you set.
- **Monthly limits.** Set shared limits per category, plus personal limits for each of you.
- **Recurring expenses.** Rent and subscriptions are added automatically each month. You can edit any month's amount.

## What each service can see

| Service | What it gets | What it can't see |
|---|---|---|
| GitHub Pages | The app's code (it's the web host) | Any of your data |
| Supabase | A random household id, record ids, timestamps, encrypted data | Amounts, names, categories, descriptions, anything else |
| frankfurter.dev | A request for the USD/INR rate, once a day | Anything about you |
| cdn.jsdelivr.net | A download of the scanner engine, the first time you scan | Your receipt photos |

> ⚠️ **If you both forget the passphrase, the data can't be recovered.** Write it down somewhere safe, and export a backup now and then (Settings → Backup).

---

## Setup (about 15 minutes, once)

### Step 1: Create the sync database (Supabase, free)

1. Go to <https://supabase.com>, sign up, and click **New project**. Choose any name, a strong database password (you won't need it again), and a nearby region.
2. When the project is ready, open **SQL Editor → New query**, paste everything from [`supabase/setup.sql`](supabase/setup.sql), and click **Run**. It should say "Success".
3. Go to **Project Settings → API Keys** (or **Settings → API**) and keep two values handy:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **publishable** key (`sb_publishable_…`), or the legacy **anon public** key (`eyJ…`).
   ❌ Never use the `service_role` or secret key.

### Step 2: Put the app online (GitHub Pages, free)

1. Sign up at <https://github.com> and click **New repository**. Name it something like `our-budget`. A **public** repo is required for free GitHub Pages; that's fine because the repo only holds code, never data or keys.
2. Click **uploading an existing file** and drag in everything inside this `our-budget` folder (`index.html`, `styles.css`, `sw.js`, `manifest.webmanifest`, and the `js`, `icons`, and `supabase` folders). Click **Commit changes**.
3. Go to **Settings → Pages**, set Source to **Deploy from a branch**, choose `main` / `(root)`, and click **Save**.
4. After about a minute, your app is live at `https://YOUR-USERNAME.github.io/our-budget/`.

### Step 3: First phone

1. Open the link in **Safari** on your iPhone.
2. Tap the **Share** button, then **Add to Home Screen**, then open **Our Budget** from the home screen.
3. Tap **Start a new household**, then enter your name and choose a passphrase. Open **Sync between our phones** and paste the Project URL and key.
4. When it asks, turn on **Face ID**.

### Step 4: Second phone

1. On the first phone, go to **Settings → Invite partner → Copy code** and send the code to your partner (a text message is fine).
2. **Tell your partner the passphrase in person or by phone**, not in the same message as the code.
3. Your partner opens the link in Safari, adds it to their Home Screen, taps **Join my partner's household**, pastes the code and the passphrase, and picks their name.

That's it. Changes sync within a few seconds whenever the app is open.

---

## Tips

- **Going out with friends who use Splitwise:** add one expense for just *your* share (for example, "Dinner w/ friends (our share)" for $40) and split it between you two as usual. Settle up with your friends in Splitwise as you normally would.
- **One of you paid for the other's personal thing:** set *Paid by* to the person who paid and *For* to the other person. The app adds it to the settle-up balance.
- **Recurring bill was different this month:** open that month's expense (it has a 🔁) and change the amount. Future months still use the usual amount.
- **Balances are all-time.** Settle-up totals carry across months until you record a payment.
- **The app locks itself** after 3 minutes in the background.

## Running it on your Mac (for testing)

```bash
cd our-budget && python3 -m http.server 8080
```

Then open <http://localhost:8080>. Tap **Try a demo with sample data** to explore. The demo passphrase is `demo-passphrase`.

Run the math tests with `npm test` (needs Node 20+).

## How the security works

- **The key:** your passphrase is stretched with PBKDF2-SHA256 (600,000 rounds), salted with your random household id, into a 256-bit AES key. The passphrase is never stored anywhere.
- **Each record:** every record (expense, category, and so on) is encrypted separately with AES-GCM, using a fresh random IV and the record id as associated data. On this phone, the IndexedDB copy is the same encrypted data.
- **While unlocked:** decrypted data exists only in memory. Locking the app, or leaving it in the background for 3 minutes, wipes the key from memory.
- **Face ID:** this uses a passkey with the WebAuthn **PRF** extension. The passkey produces a secret only after Face ID succeeds, and that secret unlocks a copy of the data key stored on this phone.
- **Supabase access:** row-level security only returns rows for the 48-character random household id the phone sends. Deletes are disabled, and deleted items sync as encrypted "tombstones".
- **Browser protection:** a strict Content-Security-Policy only allows the app's own code, the scanner engine, Supabase, and the exchange-rate API.
