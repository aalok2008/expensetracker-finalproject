import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.SPENDWISE_DATA_DIR || join(root, "data");
const storePath = join(dataDirectory, "spendwise.json");

function loadEnvironment() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z\d_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) {
      continue;
    }
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvironment();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const publishableKey = process.env.CLERK_PUBLISHABLE_KEY?.trim();
const secretKey = process.env.CLERK_SECRET_KEY?.trim();
function clerkFrontendApi(value) {
  if (!/^pk_(test|live)_[\w-]+$/.test(value ?? "")) {
    return undefined;
  }
  try {
    const payload = value.split("_")[2].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const frontendApi = decoded.slice(0, -1);
    return decoded.endsWith("$") && frontendApi.includes(".") && /^[a-z\d.-]+$/i.test(frontendApi)
      ? frontendApi
      : undefined;
  } catch {
    return undefined;
  }
}

const frontendApi = clerkFrontendApi(publishableKey);
const publishableKeyValid = Boolean(frontendApi);
const secretKeyValid = /^sk_(test|live)_[\w-]{16,}$/.test(secretKey ?? "");
const clerkConfigured = publishableKeyValid && secretKeyValid;
const clerkSetupMessage = publishableKeyValid
  ? "Replace the placeholder Clerk secret key in .env with the secret key from your Clerk development instance, then restart the server."
  : "Replace the placeholder or invalid Clerk publishable key in .env with the publishable key from your Clerk development instance, then restart the server.";
const app = express();
const starterCategories = [
  { name: "Home", type: "expense", color: "#6f9b81" },
  { name: "Food", type: "expense", color: "#d4a767" },
  { name: "Transport", type: "expense", color: "#6d91a4" },
  { name: "Health", type: "expense", color: "#bd8174" },
  { name: "Shopping", type: "expense", color: "#9c83a8" },
  { name: "Salary", type: "income", color: "#5f9a7c" },
  { name: "Other income", type: "income", color: "#7d9bba" },
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loadStore() {
  if (!existsSync(storePath)) {
    return { users: {} };
  }
  const parsed = JSON.parse(readFileSync(storePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !parsed.users || typeof parsed.users !== "object") {
    throw new Error(`Invalid data store format at ${storePath}`);
  }
  return parsed;
}

function saveStore(store) {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, storePath);
}

function accountFor(userId) {
  const store = loadStore();
  const accountKey = createHash("sha256").update(userId).digest("hex");
  let account = store.users[accountKey];
  if (!account) {
    account = {
      categories: starterCategories.map((category, index) => ({
        id: index + 1,
        ...category,
      })),
      transactions: [],
      budgets: [],
    };
    store.users[accountKey] = account;
    saveStore(store);
  }
  if (!Array.isArray(account.categories) || !Array.isArray(account.transactions) || !Array.isArray(account.budgets)) {
    throw new Error("The local account data is invalid. Restore a valid data/spendwise.json backup.");
  }
  return { store, accountKey, account };
}

function persistAccount(context) {
  context.store.users[context.accountKey] = context.account;
  saveStore(context.store);
}

function requireObject(value, label = "Request body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be a JSON object.`);
  }
  return value;
}

function validId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new HttpError(400, "A valid ID is required.");
  }
  return id;
}

function validAmount(value, label = "Amount") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw new HttpError(400, `${label} must be a positive number.`);
  }
  return Math.round(amount * 100) / 100;
}

function validMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new HttpError(400, "Month must use YYYY-MM format.");
  }
  return value;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "Date must use YYYY-MM-DD format.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, "Date is invalid.");
  }
  return value;
}

function categoryInput(body) {
  const input = requireObject(body);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 30) {
    throw new HttpError(400, "Category name must be between 1 and 30 characters.");
  }
  if (input.type !== "expense" && input.type !== "income") {
    throw new HttpError(400, "Category type must be expense or income.");
  }
  if (typeof input.color !== "string" || !/^#[\da-f]{6}$/i.test(input.color)) {
    throw new HttpError(400, "Category color must be a six-digit hex color.");
  }
  return { name, type: input.type, color: input.color };
}

function transactionInput(body, account) {
  const input = requireObject(body);
  const categoryId = validId(input.categoryId);
  if (input.type !== "expense" && input.type !== "income") {
    throw new HttpError(400, "Transaction type must be expense or income.");
  }
  const category = account.categories.find((item) => item.id === categoryId);
  if (!category || category.type !== input.type) {
    throw new HttpError(400, "Choose an existing category of the same transaction type.");
  }
  const note = input.note === undefined || input.note === null ? "" : input.note;
  if (typeof note !== "string" || note.length > 200) {
    throw new HttpError(400, "Note must be 200 characters or fewer.");
  }
  return {
    categoryId,
    categoryName: category.name,
    categoryColor: category.color,
    type: input.type,
    amount: validAmount(input.amount),
    date: validDate(input.date),
    note: note.trim(),
  };
}

function transactionFilters(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "Page must be positive and limit must be between 1 and 100.");
  }
  const categoryId = query.categoryId === undefined ? undefined : validId(query.categoryId);
  const type = query.type === undefined || query.type === "" ? undefined : query.type;
  if (type !== undefined && type !== "expense" && type !== "income") {
    throw new HttpError(400, "Transaction type must be expense or income.");
  }
  return {
    page,
    limit,
    q: typeof query.q === "string" ? query.q.trim().toLocaleLowerCase() : "",
    type,
    categoryId,
    from: query.from ? validDate(query.from) : undefined,
    to: query.to ? validDate(query.to) : undefined,
  };
}

function filteredTransactions(account, filters) {
  return account.transactions
    .filter((item) => !filters.q
      || item.note.toLocaleLowerCase().includes(filters.q)
      || item.categoryName.toLocaleLowerCase().includes(filters.q))
    .filter((item) => !filters.type || item.type === filters.type)
    .filter((item) => filters.categoryId === undefined || item.categoryId === filters.categoryId)
    .filter((item) => !filters.from || item.date >= filters.from)
    .filter((item) => !filters.to || item.date <= filters.to)
    .sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id));
}

function budgetRows(account, month) {
  return account.budgets
    .filter((budget) => budget.month === month)
    .map((budget) => {
      const category = account.categories.find((item) => item.id === budget.categoryId);
      const spent = account.transactions
        .filter((transaction) => transaction.type === "expense"
          && transaction.categoryId === budget.categoryId
          && transaction.date.startsWith(month))
        .reduce((total, transaction) => total + transaction.amount, 0);
      return {
        ...budget,
        categoryName: category?.name ?? "Deleted category",
        spent: Math.round(spent * 100) / 100,
      };
    });
}

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

function reportSummary(account, month) {
  const totals = account.transactions
    .filter((item) => item.date.startsWith(month))
    .reduce((result, item) => {
      result[item.type] += item.amount;
      return result;
    }, { income: 0, expense: 0 });
  return {
    income: Math.round(totals.income * 100) / 100,
    expense: Math.round(totals.expense * 100) / 100,
    balance: Math.round((totals.income - totals.expense) * 100) / 100,
  };
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (req, res) => {
  res.status(clerkConfigured ? 200 : 503).json({ status: clerkConfigured ? "ok" : "setup_required" });
});

if (clerkConfigured) {
  app.use("/api", clerkMiddleware({ publishableKey, secretKey }));
  app.use("/api", (req, res, next) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      return res.status(401).json({ error: "Sign in to access your SpendWise data." });
    }
    if (req.method === "GET") {
      res.setHeader("X-SpendWise-User", createHash("sha256").update(auth.userId).digest("hex"));
      res.setHeader("Cache-Control", "private, no-store");
    }
    req.spendwiseUserId = auth.userId;
    next();
  });
} else {
  app.use("/api", (req, res, next) => {
    res.status(503).json({ error: "Configure both Clerk keys in .env to use the app." });
  });
}

app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok", authenticated: true });
});

app.get("/api/categories", (req, res) => {
  const { account } = accountFor(req.spendwiseUserId);
  res.json(account.categories);
});

app.post("/api/categories", (req, res) => {
  const context = accountFor(req.spendwiseUserId);
  const input = categoryInput(req.body);
  if (context.account.categories.some((category) => category.name.toLocaleLowerCase() === input.name.toLocaleLowerCase()
      && category.type === input.type)) {
    throw new HttpError(409, "A category with that name already exists.");
  }
  const id = Math.max(0, ...context.account.categories.map((category) => category.id)) + 1;
  const category = { id, ...input };
  context.account.categories.push(category);
  persistAccount(context);
  res.status(201).json(category);
});

app.delete("/api/categories/:id", (req, res) => {
  const context = accountFor(req.spendwiseUserId);
  const id = validId(req.params.id);
  const index = context.account.categories.findIndex((category) => category.id === id);
  if (index < 0) {
    throw new HttpError(404, "Category not found.");
  }
  if (context.account.transactions.some((transaction) => transaction.categoryId === id)
      || context.account.budgets.some((budget) => budget.categoryId === id)) {
    throw new HttpError(409, "Categories in use can’t be deleted.");
  }
  context.account.categories.splice(index, 1);
  persistAccount(context);
  res.status(204).end();
});

app.get("/api/transactions/export", (req, res) => {
  const { account } = accountFor(req.spendwiseUserId);
  const rows = filteredTransactions(account, transactionFilters(req.query));
  const csv = [
    ["Date", "Type", "Category", "Amount", "Note"].map(csvCell).join(","),
    ...rows.map((item) => [item.date, item.type, item.categoryName, item.amount, item.note].map(csvCell).join(",")),
  ].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="spendwise-transactions.csv"');
  res.send(`\uFEFF${csv}`);
});

app.get("/api/transactions", (req, res) => {
  const { account } = accountFor(req.spendwiseUserId);
  const filters = transactionFilters(req.query);
  const rows = filteredTransactions(account, filters);
  res.json({
    items: rows.slice((filters.page - 1) * filters.limit, filters.page * filters.limit),
    page: filters.page,
    pages: Math.max(1, Math.ceil(rows.length / filters.limit)),
    total: rows.length,
  });
});

app.post("/api/transactions", (req, res) => {
  const context = accountFor(req.spendwiseUserId);
  const transaction = { id: randomUUID(), ...transactionInput(req.body, context.account) };
  context.account.transactions.push(transaction);
  persistAccount(context);
  res.status(201).json(transaction);
});

app.put("/api/transactions/:id", (req, res) => {
  const context = accountFor(req.spendwiseUserId);
  const index = context.account.transactions.findIndex((item) => item.id === req.params.id);
  if (index < 0) {
    throw new HttpError(404, "Transaction not found.");
  }
  const updated = { ...context.account.transactions[index], ...transactionInput(req.body, context.account) };
  context.account.transactions[index] = updated;
  persistAccount(context);
  res.json(updated);
});

app.delete("/api/transactions/:id", (req, res) => {
  const context = accountFor(req.spendwiseUserId);
  const index = context.account.transactions.findIndex((item) => item.id === req.params.id);
  if (index < 0) {
    throw new HttpError(404, "Transaction not found.");
  }
  context.account.transactions.splice(index, 1);
  persistAccount(context);
  res.status(204).end();
});

app.get("/api/budgets", (req, res) => {
  const { account } = accountFor(req.spendwiseUserId);
  const month = validMonth(typeof req.query.month === "string" ? req.query.month : currentMonth());
  res.json(budgetRows(account, month));
});

app.put("/api/budgets", (req, res) => {
  const context = accountFor(req.spendwiseUserId);
  const input = requireObject(req.body);
  const categoryId = validId(input.categoryId);
  const category = context.account.categories.find((item) => item.id === categoryId && item.type === "expense");
  if (!category) {
    throw new HttpError(400, "Choose an existing expense category.");
  }
  const month = validMonth(input.month);
  const amount = validAmount(input.amount);
  let budget = context.account.budgets.find((item) => item.categoryId === categoryId && item.month === month);
  if (budget) {
    budget.amount = amount;
  } else {
    budget = { id: randomUUID(), categoryId, month, amount };
    context.account.budgets.push(budget);
  }
  persistAccount(context);
  res.json({
    ...budget,
    categoryName: category.name,
    spent: budgetRows(context.account, month).find((item) => item.id === budget.id)?.spent ?? 0,
  });
});

app.delete("/api/budgets/:id", (req, res) => {
  const context = accountFor(req.spendwiseUserId);
  const index = context.account.budgets.findIndex((item) => item.id === req.params.id);
  if (index < 0) {
    throw new HttpError(404, "Budget not found.");
  }
  context.account.budgets.splice(index, 1);
  persistAccount(context);
  res.status(204).end();
});

app.get("/api/reports/summary", (req, res) => {
  const { account } = accountFor(req.spendwiseUserId);
  const month = validMonth(typeof req.query.month === "string" ? req.query.month : currentMonth());
  res.json(reportSummary(account, month));
});

app.get("/api/reports/trend", (req, res) => {
  const { account } = accountFor(req.spendwiseUserId);
  const months = req.query.months === undefined ? 6 : Number(req.query.months);
  if (!Number.isSafeInteger(months) || months < 1 || months > 24) {
    throw new HttpError(400, "Trend range must be between 1 and 24 months.");
  }
  const [year, month] = currentMonth().split("-").map(Number);
  const labels = Array.from({ length: months }, (_, index) => {
    const date = new Date(Date.UTC(year, month - months + index, 1, 12));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const reports = labels.map((label) => reportSummary(account, label));
  res.json({
    months: labels,
    income: reports.map((report) => report.income),
    expense: reports.map((report) => report.expense),
  });
});

app.get("/logo.svg", (req, res) => {
  res.sendFile(join(root, "images", "favicon.svg"));
});

app.get("/offline.html", (req, res) => {
  res.sendFile(join(root, "offline.html"));
});

app.get("/manifest.webmanifest", (req, res) => {
  res.type("application/manifest+json").sendFile(join(root, "manifest.webmanifest"));
});

app.get("/service-worker.js", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.type("application/javascript").sendFile(join(root, "service-worker.js"));
});

app.get("/clerk.browser.js", async (req, res, next) => {
  if (!frontendApi) {
    return res.status(503).type("text").send("Configure a valid Clerk publishable key to load Clerk.");
  }
  try {
    const clerkJsUrl = `https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
    const response = await fetch(clerkJsUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      return res.status(502).type("text").send(`Clerk frontend returned HTTP ${response.status}.`);
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("application/javascript").send(await response.text());
  } catch (error) {
    next(error);
  }
});

async function proxyClerkUiAsset(version, asset, res, next) {
  if (!frontendApi) {
    return res.status(503).type("text").send("Configure a valid Clerk publishable key to load Clerk.");
  }
  try {
    const clerkUiUrl = `https://${frontendApi}/npm/@clerk/ui@${version}/dist/${asset}`;
    const response = await fetch(clerkUiUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      return res.status(502).type("text").send(`Clerk UI returned HTTP ${response.status}.`);
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("application/javascript").send(await response.text());
  } catch (error) {
    next(error);
  }
}

app.get(/^\/npm\/@clerk\/ui@([^/]+)\/dist\/([^/]+\.js)$/, (req, res, next) => {
  const version = req.params[0];
  const asset = req.params[1];
  if (!/^\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9.-]+)?$/.test(version)
      || !/^[A-Za-z0-9._-]+\.js$/.test(asset)) {
    return res.status(400).type("text").send("Invalid Clerk UI asset name.");
  }
  proxyClerkUiAsset(version, asset, res, next);
});

app.get("/js/index-CAYczt9A.js", (req, res, next) => {
  if (!clerkConfigured) {
    return res.status(503).type("text").send("Set CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY in .env before starting SpendWise.");
  }
  try {
    const bundlePath = join(root, "js", "index-CAYczt9A.js");
    const original = readFileSync(bundlePath, "utf8");
    const originalKey = "pk_live_Y2xlcmsuc3BlbmQtd2lzZS1leHBlbnNlLXRyYWNrZXItLXRyaXZlZGlhYWxvazI0LnJlcGxpdC5hcHAk";
    const marker = `VITE_CLERK_PUBLISHABLE_KEY:"${originalKey}"`;
    const accountChangeMarker = "i.current!==void 0&&i.current!==c&&s.clear(),i.current=c";
    const clerkProviderMarker = "proxyUrl:Ek,appearance:_k";
    if (!original.includes(marker)
        || original.split(originalKey).length - 1 !== 2
        || !original.includes('Ek="/api/__clerk"')
        || !original.includes(accountChangeMarker)
        || !original.includes(clerkProviderMarker)) {
      throw new Error("The compiled frontend no longer contains the expected Clerk configuration markers.");
    }
    const configured = original
      .replaceAll(originalKey, publishableKey)
      .replace('Ek="/api/__clerk"', "Ek=void 0")
      .replace(clerkProviderMarker, 'proxyUrl:Ek,__internal_clerkJSUrl:"/clerk.browser.js",__internal_clerkUIUrl:"/npm/@clerk/ui@1/dist/ui.browser.js",appearance:_k')
      .replace(
        accountChangeMarker,
        'i.current!==void 0&&i.current!==c&&(s.clear(),navigator.serviceWorker?.controller?.postMessage({type:"CLEAR_PRIVATE_DATA"})),i.current=c',
      );
    res.type("application/javascript").send(configured);
  } catch (error) {
    next(error);
  }
});

app.use("/css", express.static(join(root, "css")));
app.use("/images", express.static(join(root, "images")));
app.get("/", (req, res) => {
  if (!clerkConfigured) {
    return res.status(503).type("html").send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SpendWise setup required</title><body style="font:16px system-ui;max-width:42rem;margin:10vh auto;padding:0 1.5rem;color:#294a40"><h1>SpendWise needs valid Clerk keys</h1><p>${clerkSetupMessage}</p><p>Copy the real keys from your Clerk dashboard. Keep the secret key private. See <code>README.md</code> for setup instructions.</p></body></html>`,
    );
  }
  res.sendFile(join(root, "index.html"));
});

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api/")
      || req.path.startsWith("/js/")
      || req.path.startsWith("/service-worker")
      || req.path.startsWith("/css/")
      || req.path.startsWith("/images/")
      || extname(req.path)) {
    return res.status(404).json({ error: "Not found." });
  }
  return clerkConfigured ? res.sendFile(join(root, "index.html")) : next();
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Request body must contain valid JSON." });
  }
  console.error("SpendWise request failed:", error);
  return res.status(500).json({ error: "The request could not be completed." });
});

if (!clerkConfigured) {
  console.warn("SpendWise is running in setup mode. Add valid Clerk keys to .env to enable sign-in and the API.");
}
app.listen(port, host, () => {
  console.log(`SpendWise is running at http://${host}:${port}`);
});
