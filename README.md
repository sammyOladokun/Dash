# Northstar — Personal OS

A browser-based personal dashboard prototype.

## Requirements

- Node.js 20.19+ (or 22.12+)
- npm 10+

## Start the development server

```sh
npm install
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`.

## Local workflow engine

`npm run dev` starts both Vite and the local LifeOS API. The API reads and writes
`backend/data/lifeos.json`, which is preloaded with the dashboard's sample goals,
projects, and tasks. Changes are saved in that file and remain after a restart.

The Projects & Tasks screen has a **Weekly Review** action. It checks for overdue
and soon-due tasks, stale projects, past-due goals, and goals without a linked
project. Findings include their reason and a suggested next action; you can
dismiss a finding or create a follow-up task. Completing a task and adding
goals, projects, and tasks also saves through the local API.

Entity-specific **Add …** actions open matching forms (for example, products,
businesses, domains, investments, income, events, and learning resources).
Records outside goals, projects, and tasks are saved in named collections in
the same JSON database through `/api/records/:collection`.

The review engine uses calendar dates and the sample records retain their
original 2025 dates, so the first review will correctly flag many of those
sample items as overdue. Replace the sample dates with your real dates before
using the findings for planning.

The API binds to `127.0.0.1:3001` and is intended for local development. It has
no login or remote-access security; do not expose it to the public internet.
The JSON file is the initial lightweight database and can later be migrated to
SQLite without changing the review rules' record format.

## Production build

```sh
npm run build
npm run preview
```

The production files are written to `dist/`. To serve the API separately in a
local production-style setup, run `npm run start:api` alongside the static app.
