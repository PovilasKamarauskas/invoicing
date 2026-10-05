import { createRequire } from "node:module";
const require = createRequire(
  new URL("../backend/package.json", import.meta.url),
);
const puppeteer = require("puppeteer").default;
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const downloadSession = await page.createCDPSession();
  await downloadSession.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  const errors = [];
  let generated = 0;
  const savedPayloads = new Map();
  const keys = [];
  let deletedHighest = false;
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    const seller = {
      name: "Test Seller",
      address: "Vilnius",
      individualActivity: "",
      taxNumber: "",
      bankName: "",
      swift: "",
      iban: "",
    };
    const buyer = { name: "Test Buyer", address: "Vilnius", vatCode: "" };
    if (path === "/api/auth/me")
      return r.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          capabilities: {backupStatus:true},
          user: { id: 900, email: "review@example.invalid" },
          preferences: {
            seller,
            buyer,
            lastInvoiceNumber: "SF 008",
            savedItems: [],
          },
        }),
      });
    if (path === '/api/system/backup-status') return r.respond({status:200,contentType:'application/json',body:JSON.stringify({enabled:true,running:false,destinationAvailable:true,lastSuccess:Date.now(),secondaryConfigured:false})});
    if (path === "/invoice/generate") {
      generated++;
      const number = `SF ${43 + generated}`;
      keys.push(r.headers()['idempotency-key']);
      savedPayloads.set(122 + generated, {...JSON.parse(r.postData()),invoiceNumber:number});
      return r.respond({
        status: 201,
        contentType: "application/zip",
        headers: {
          "X-Invoice-Id": String(122 + generated),
          "X-Invoice-Number": encodeURIComponent(number),
          "X-Invoice-Email-Status": "not_configured",
        },
        body: Buffer.from("review-zip"),
      });
    }
    const details = path.match(/^\/invoice\/history\/(123|124)$/);
    if (details) { const payload=savedPayloads.get(Number(details[1])); return r.respond({status:200,contentType:"application/json",body:JSON.stringify({id:Number(details[1]),invoiceNumber:payload.invoiceNumber,payload})}); }
    if (path === "/invoice/history/123/download")
      return r.respond({
        status: 200,
        contentType: "application/zip",
        body: Buffer.from("review-zip"),
      });
    if (path === "/invoice/history" && r.method() === "GET") return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ invoices: deletedHighest ? [] : [{ id: 44, invoiceNumber: "SF 44", invoiceDate: "2026-10-03", paymentTerm: "2026-11-02", buyerName: "Test Buyer", total: 1, createdAt: Date.now(), regeneratedAt: null, emailStatus: null, emailSentAt: null }], nextCursor: null }) });
    if (path === "/invoice/history/44" && r.method() === "DELETE") { deletedHighest = true; return r.respond({ status: 200, contentType: "application/json", body: '{"deleted":true,"id":44}' }); }
    if (path === "/invoice/next-number")
      return r.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ invoiceNumber: generated ? `SF ${44 + generated}` : deletedHighest ? "SF 44" : "SF 45" }),
      });
    if (path.startsWith("/api/") || path.startsWith("/invoice/"))
      return r.respond({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    r.continue();
  });
  await page.goto(process.env.REVIEW_URL || "http://127.0.0.1:5173", {
    waitUntil: "networkidle0",
  });
  if (errors.length) throw new Error(errors.join("; "));
  await page.waitForSelector('[aria-label="Description for item 1"]');
  await page.waitForFunction(() => document.querySelector('#invoice-field-1').value === 'SF 45');
  const expectedDays = await page.evaluate(() => {
    const now = new Date(); let days = 0;
    for (let day = 1; day <= new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); day++) { const weekday = new Date(now.getFullYear(), now.getMonth(), day).getDay(); if (weekday !== 0 && weekday !== 6) days++; }
    return days;
  });
  const quantity = await page.$eval('[aria-label="Quantity for item 1"]', e => Number(e.value));
  if (quantity !== expectedDays) throw new Error('Incorrect monthly working days');
  await page.locator('.workspace-tabs button:nth-child(2)').click();
  await page.waitForSelector('[aria-label="Delete invoice SF 44"]');
  await page.locator('[aria-label="Delete invoice SF 44"]').click();
  await page.locator('.delete-confirmation .btn-delete').click();
  await page.waitForFunction(() => document.body.innerText.includes('SF 44 deleted from your history.'));
  await page.locator('.workspace-tabs button:first-child').click();
  await page.waitForFunction(() => document.querySelector('#invoice-field-1').value === 'SF 44');
  await page.locator(".summary-card .btn-primary").click();
  await page.waitForFunction(() =>
    document.body.innerText.includes("Please correct the highlighted fields."),
  );
  if (generated) throw new Error("Invalid form submitted");
  async function fill(label, value) {
    const s = `[aria-label="${label}"]`;
    await page.focus(s);
    const previous = await page.$eval(s, e => e.value);
    await page.keyboard.press("End");
    for (let i = 0; i <= previous.length; i++) await page.keyboard.press("Backspace");
    await page.type(s, value);
    if ((await page.$eval(s, (e) => e.value)) !== value)
      throw new Error("Could not type " + label);
  }
  await fill("Description for item 1", "Half hour");
  await fill("Quantity for item 1", "0.5");
  await fill("Price in euros for item 1", "0.01");
  await page.locator(".items-footer button").click();
  if (await page.$eval('[aria-label="Quantity for item 2"]', e => Number(e.value)) !== 1) throw new Error('Extra row should default to 1');
  await fill("Description for item 2", "Half hour");
  await fill("Quantity for item 2", "0.5");
  await fill("Price in euros for item 2", "0.01");
  const total = await page.$eval(".summary-total strong", (e) => e.textContent);
  if (!total.includes("0.02")) throw new Error("Wrong preview total " + total);
  await page.locator(".summary-card .btn-primary").click();
  await page.waitForFunction(() => document.body.innerText.includes('SF 44 saved to your history.') && !document.querySelector('.summary-card .btn-primary').disabled);
  if (generated !== 1) throw new Error('Duplicate generation');
  if (await page.$eval('#invoice-field-1', e => e.matches(':disabled'))) throw new Error('Form locked after generation');
  await page.waitForFunction(() => document.querySelector('#invoice-field-1').value === 'SF 45');
  if (await page.$eval('[aria-label="Description for item 1"]', e => e.value) !== 'Half hour') throw new Error('Generated items were cleared');
  await page.evaluate(() => [...document.querySelectorAll('.summary-card button')].find(b => b.textContent === 'Download last invoice').click());
  await page.waitForFunction(() => !document.querySelector('.summary-card .btn-primary').disabled);
  if (generated !== 1) throw new Error('Download created another invoice');
  await fill('Description for item 1', 'Second invoice work');
  await page.locator('.summary-card .btn-primary').click();
  await page.waitForFunction(() => document.body.innerText.includes('SF 45 saved to your history.') && !document.querySelector('.summary-card .btn-primary').disabled);
  if (generated !== 2 || keys[0] === keys[1]) throw new Error('Second invoice did not use a fresh generation request');
  if (savedPayloads.get(123).items[0].description !== 'Half hour' || savedPayloads.get(124).items[0].description !== 'Second invoice work') throw new Error('Second generation changed the first invoice');
  await page.waitForFunction(() => document.querySelector('#invoice-field-1').value === 'SF 46');
  await page.locator('.summary-card button:last-of-type').click();
  await page.waitForFunction(days => Number(document.querySelector('[aria-label="Quantity for item 1"]').value) === days, {}, expectedDays);
  if (await page.$eval('#invoice-field-1', e => e.matches(':disabled'))) throw new Error('New form disabled');
  await page.evaluate(() => [...document.querySelectorAll('.workspace-tabs button')].find(b => b.textContent==='Settings').click());
  await page.waitForFunction(() => document.querySelector('.backup-settings')?.innerText.includes('Enabled'));
  if (!(await page.$eval('.backup-settings',e => e.innerText)).includes('Not configured')) throw new Error('Secondary destination status missing');
  if (errors.length) throw new Error(errors.join("; "));
  console.log(
    JSON.stringify({
      url: process.env.REVIEW_URL || "http://127.0.0.1:5173",
      preview: total,
      generated,
      validation: true,
      newInvoice: true,
      backupSettings:true,
      consecutiveGeneration: true,
      retainedFirstInvoice: true,
      deletedNumberRefreshed: deletedHighest,
      workingDays: expectedDays,
      browserErrors: errors,
    }),
  );
} finally {
  try {
    await Promise.race([browser.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('Browser cleanup timeout')), 5000))]);
  } catch { browser.process()?.kill('SIGKILL'); }
}
