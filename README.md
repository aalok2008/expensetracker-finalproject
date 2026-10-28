# SpendWise

SpendWise is a locally hosted expense tracker. It uses the included frontend,
Clerk for account sign-in, and a small local API that stores each account's
categories, transactions, and budgets in `data/spendwise.json`.

## Requirements

- Node.js 20.6 or newer
- A Clerk account and application

## Run locally

1. In the project folder, install dependencies:

   ```powershell
   npm install
   ```

2. Install the Clerk CLI and sign in:

   ```powershell
   npm install -g clerk
   clerk auth login
   ```

3. Link the project to your Clerk application and retrieve its development
   keys. Replace the example app ID with your Clerk application ID if needed:

   ```powershell
   clerk init --app app_your_application_id
   ```

   This creates or updates `.env`. Keep the secret key private and do not
   commit the file.

4. Check the setup and start the server:

   ```powershell
   clerk doctor
   npm run dev
   ```

5. Open <http://localhost:3000>.

The server also supports `npm start` for a non-watch run. The first visit to
`/` shows a setup page if either Clerk key is missing. For Clerk, use a
development instance and allow `http://localhost:3000` as an application
origin if the instance asks for allowed origins.

## Install on a phone

SpendWise can be installed as a Progressive Web App (PWA):

- **Android:** open the live HTTPS site in Chrome, open the browser menu, then
  choose **Install app** or **Add to Home screen**.
- **iPhone/iPad:** open the live HTTPS site in Safari, tap **Share**, choose
  **Add to Home Screen**, and confirm.

The development server's `localhost` address is only reachable on the
computer running it; it is not the address to enter on a phone. The Render
Blueprint in `render.yaml` configures HTTPS hosting and a persistent disk for
the local JSON data file.

To publish with Render:

1. Push this project to a private GitHub repository. Do not include `.env`;
   Clerk secret keys must stay out of GitHub.
2. In Render, choose **New + → Blueprint**, connect the repository, and apply
   `render.yaml`.
3. When prompted, set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` using the
   development keys from the linked Clerk application. Render's Starter web
   service and persistent disk can incur a charge; review the price shown in
   Render before creating the service.
4. After Render provides your HTTPS URL, add that URL as an allowed origin in
   your Clerk application's domain/origin settings. Open the URL in a browser
   and sign in while online.
5. With the site open online, visit the dashboard, transactions, budgets, and
   categories once to save those screens' data for offline viewing.
6. Install from your phone's browser menu (**Install app** on Android Chrome;
   **Share → Add to Home Screen** on iPhone Safari).

SpendWise caches the app shell, Clerk's sign-in scripts and UI assets, and
private GET responses on each device. After the first online visit, you can
reopen the app and view pages and data that were previously loaded, but
adding/editing data and signing in require an internet connection. Cached
finance data is cleared when you sign out or switch accounts. Offline pages
can be out of date; reconnect to refresh them.

## Local data and API

The server keeps data in `data/spendwise.json`, separated by the authenticated
Clerk user ID. It creates starter categories for new accounts; transactions
and budgets are only added by the signed-in user. Back up that file if you
want to keep your local data.

The API implements the frontend's health, categories, transactions, budget,
and report endpoints. API requests require a valid Clerk session. No finance
data is sent to an external service; Clerk handles authentication.
