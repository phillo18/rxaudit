'use strict';

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
// Base URL suffix shared by all v2 functions in this project
const FUNCTION_HASH = '2d7zryzrxa';
const FUNCTION_BASE_TPL = (name) => `https://${name}-${FUNCTION_HASH}-uc.a.run.app`;

// Secrets — set via: firebase functions:secrets:set XERO_CLIENT_ID
const XERO_CLIENT_ID = defineSecret('XERO_CLIENT_ID');
const XERO_CLIENT_SECRET = defineSecret('XERO_CLIENT_SECRET');
const XERO_WEBHOOK_KEY = defineSecret('XERO_WEBHOOK_KEY');

// ── HELPERS ────────────────────────────────────────────────────

async function getXeroToken() {
  const doc = await db.collection('billing').doc('xeroTokens').get();
  if (!doc.exists) throw new Error('Xero not connected — visit /xeroAuth first');
  const d = doc.data();

  if (Date.now() >= d.expiry - 300000) {
    const res = await axios.post(
      XERO_TOKEN_URL,
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(d.refreshToken)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(
            `${XERO_CLIENT_ID.value()}:${XERO_CLIENT_SECRET.value()}`
          ).toString('base64'),
        },
      }
    );
    const tokens = {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiry: Date.now() + res.data.expires_in * 1000,
    };
    await db.collection('billing').doc('xeroTokens').update(tokens);
    return tokens.accessToken;
  }
  return d.accessToken;
}

async function getXeroTenantId() {
  const doc = await db.collection('billing').doc('config').get();
  if (!doc.exists) throw new Error('Xero tenant not configured');
  return doc.data().xeroTenantId;
}

async function ensureXeroContact(nurseId, nurseName, nurseEmail, token, tenantId) {
  const ref = db.collection('billing').doc(nurseId);
  const snap = await ref.get();
  if (snap.exists && snap.data().xeroContactId) return snap.data().xeroContactId;

  const res = await axios.post(
    `${XERO_API_BASE}/Contacts`,
    { Contacts: [{ Name: nurseName, EmailAddress: nurseEmail || '' }] },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
      },
    }
  );
  const contactId = res.data.Contacts[0].ContactID;
  await ref.set({ xeroContactId: contactId }, { merge: true });
  return contactId;
}

// ── XERO OAUTH ─────────────────────────────────────────────────

exports.xeroAuth = onRequest(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET], invoker: 'public' },
  (req, res) => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: XERO_CLIENT_ID.value(),
      redirect_uri: FUNCTION_BASE_TPL('xerocallback'),
      scope: 'accounting.contacts accounting.invoices accounting.settings offline_access',
      state: crypto.randomBytes(16).toString('hex'),
    });
    res.redirect(`${XERO_AUTH_URL}?${params}`);
  }
);

exports.xeroCallback = onRequest(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET], invoker: 'public' },
  async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) { res.status(400).send('Missing authorization code'); return; }

      const tokenRes = await axios.post(
        XERO_TOKEN_URL,
        `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(FUNCTION_BASE_TPL('xerocallback'))}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(
              `${XERO_CLIENT_ID.value()}:${XERO_CLIENT_SECRET.value()}`
            ).toString('base64'),
          },
        }
      );

      const tenantsRes = await axios.get('https://api.xero.com/connections', {
        headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      });
      const tenantId = tenantsRes.data[0].tenantId;
      const tenantName = tenantsRes.data[0].tenantName;

      await db.collection('billing').doc('xeroTokens').set({
        accessToken: tokenRes.data.access_token,
        refreshToken: tokenRes.data.refresh_token,
        expiry: Date.now() + tokenRes.data.expires_in * 1000,
      });
      await db.collection('billing').doc('config').set(
        { xeroTenantId: tenantId, xeroTenantName: tenantName, xeroConnected: true },
        { merge: true }
      );

      res.send(`
        <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2 style="color:#1a4d6e;">&#10003; Xero Connected</h2>
        <p>Organisation: <strong>${tenantName}</strong></p>
        <p>You can close this tab and return to RxAudit.</p>
        </body></html>
      `);
    } catch (e) {
      console.error('xeroCallback error:', e.response ? e.response.data : e.message);
      res.status(500).send('Xero connection failed: ' + e.message);
    }
  }
);

// ── BILLING RUN ────────────────────────────────────────────────

async function runBillingForAllNurses(clientId, clientSecret) {
  const token = await getXeroToken();
  const tenantId = await getXeroTenantId();

  const usersDoc = await db.collection('data').doc('users').get();
  const users = usersDoc.exists ? (usersDoc.data().list || []) : [];
  const nurses = users.filter(u => u.role === 'nurse' && u.active !== false);

  const now = new Date();
  const brisbaneNow = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
  const monthKey = `${brisbaneNow.getFullYear()}-${String(brisbaneNow.getMonth() + 1).padStart(2, '0')}`;
  const dueDateFmt = `${brisbaneNow.getFullYear()}-${String(brisbaneNow.getMonth() + 1).padStart(2, '0')}-${String(brisbaneNow.getDate()).padStart(2, '0')}`;

  // Load billing config once
  const configDoc = await db.collection('billing').doc('config').get();
  const billingDay = configDoc.exists ? (configDoc.data().billingDay || 1) : 1;

  // Advance billing: invoice sent today covers next month's cycle
  const nextMonth = new Date(brisbaneNow.getFullYear(), brisbaneNow.getMonth() + 1, billingDay);
  const advanceLabel = nextMonth.toLocaleString('en-AU', { month: 'long', year: 'numeric' });

  // Previous billing date (same day last month) for pro-rata cycle calculation
  const prevBillingDate = new Date(brisbaneNow.getFullYear(), brisbaneNow.getMonth() - 1, billingDay);

  const results = [];

  for (const nurse of nurses) {
    const nurseId = String(nurse.id);
    try {
      const billingSnap = await db.collection('billing').doc(nurseId).get();
      const billing = billingSnap.exists ? billingSnap.data() : {};
      const monthlyRate = billing.monthlyRate || 0;
      if (!monthlyRate) { results.push({ nurse: nurse.name, status: 'skipped', reason: 'no rate set' }); continue; }

      // Pro-rata: nurse started after previous billing date → first invoice covers start date to today
      let chargeAmount = monthlyRate;
      let invoiceDescription = `RxAudit Platform — ${advanceLabel} (advance)`;
      if (billing.startDate) {
        const startDate = new Date(billing.startDate + 'T00:00:00');
        if (startDate > prevBillingDate) {
          // Pro-rata: covers startDate → today (this billing day)
          const cycleDays = Math.round((brisbaneNow - prevBillingDate) / 86400000);
          const activeDays = Math.round((brisbaneNow - startDate) / 86400000);
          if (activeDays <= 0) {
            results.push({ nurse: nurse.name, status: 'skipped', reason: 'start date is in the future' });
            continue;
          }
          chargeAmount = Math.round(monthlyRate * activeDays / cycleDays * 100) / 100;
          const startFmt = startDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
          const endFmt = brisbaneNow.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
          invoiceDescription = `RxAudit Platform — ${startFmt} to ${endFmt} (pro-rata)`;
        }
      }

      const existing = await db.collection('billingPayments')
        .where('nurseId', '==', nurseId).where('month', '==', monthKey).limit(1).get();
      let activeInvoice = null;
      for (const doc of existing.docs) {
        const data = doc.data();
        if (data.status === 'VOIDED') continue;
        if (data.xeroInvoiceId) {
          try {
            const invCheck = await axios.get(`${XERO_API_BASE}/Invoices/${data.xeroInvoiceId}`, {
              headers: { Authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId },
            });
            const xeroStatus = invCheck.data.Invoices[0].Status;
            if (xeroStatus === 'VOIDED' || xeroStatus === 'DELETED') {
              await doc.ref.update({ status: xeroStatus });
              continue;
            }
          } catch (_) {}
        }
        activeInvoice = doc;
        break;
      }
      if (activeInvoice) { results.push({ nurse: nurse.name, status: 'skipped', reason: 'already invoiced this month' }); continue; }

      const contactId = await ensureXeroContact(nurseId, nurse.name, nurse.email || '', token, tenantId);
      console.log(`[billing] ${nurse.name}: contact ${contactId}, charge ${chargeAmount}, desc: ${invoiceDescription}`);

      const gst = Math.round(chargeAmount * 0.1 * 100) / 100;
      const yymm = monthKey.slice(2).replace('-', '');
      const words = nurse.name.trim().split(/\s+/);
      const initials2 = words.map(w => w[0]).join('').toUpperCase().slice(0, 2);
      const initials3 = words.map(w => w[0]).join('').toUpperCase().slice(0, 3);
      const invoiceNumberBase = `${initials2}${yymm}`;

      let invoiceRes;
      for (let attempt = 0; attempt <= 9; attempt++) {
        const invoiceNumber = attempt === 0 ? invoiceNumberBase : attempt === 1 ? `${initials3}${yymm}` : `${initials3}${yymm}${attempt}`;
        let isDuplicateNumber = false;
        try {
        invoiceRes = await axios.post(
          `${XERO_API_BASE}/Invoices`,
          {
            Invoices: [{
              Type: 'ACCREC',
              Contact: { ContactID: contactId },
              DueDate: dueDateFmt,
              InvoiceNumber: invoiceNumber,
              Status: 'AUTHORISED',
              SentToContact: false,
              LineItems: [{
                Description: invoiceDescription,
                Quantity: 1,
                UnitAmount: chargeAmount,
                AccountCode: '200',
              }],
            }],
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'xero-tenant-id': tenantId,
              'Content-Type': 'application/json',
            },
          }
        );
        } catch (xeroErr) {
          const xeroData = xeroErr.response ? xeroErr.response.data : null;
          const xeroStr = JSON.stringify(xeroData || '');
          const dupError = xeroStr.includes('duplicate') || xeroStr.includes('not of valid status for modification');
          if (dupError && attempt < 9) { isDuplicateNumber = true; }
          else {
            const xeroDetail = xeroData ? JSON.stringify(xeroData) : xeroErr.message;
            console.error(`[billing] ${nurse.name}: Xero invoice API error:`, xeroDetail);
            throw new Error('Xero invoice error: ' + xeroDetail);
          }
        }
        if (!isDuplicateNumber) break;
      }

      const inv = invoiceRes.data.Invoices[0];
      if (inv.HasErrors) {
        const errs = (inv.ValidationErrors || []).map(e => e.Message).join('; ');
        console.error(`[billing] ${nurse.name}: Xero validation errors:`, errs);
        throw new Error('Xero validation: ' + errs);
      }

      if (nurse.email) {
        try {
          await axios.post(
            `${XERO_API_BASE}/Invoices/${inv.InvoiceID}/Email`,
            {},
            { headers: { Authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId, 'Content-Type': 'application/json' } }
          );
        } catch (emailErr) {
          console.warn(`[billing] ${nurse.name}: email send failed (invoice still created):`, emailErr.message);
        }
      }

      await db.collection('billingPayments').add({
        nurseId,
        nurseName: nurse.name,
        nurseClinic: nurse.clinic || '',
        amount: chargeAmount,
        gst,
        total: monthlyRate + gst,
        date: dueDateFmt,
        month: monthKey,
        xeroInvoiceId: inv.InvoiceID,
        xeroInvoiceNumber: inv.InvoiceNumber,
        status: 'PENDING',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('billing').doc(nurseId).set({
        status: 'PENDING',
        lastInvoiceDate: dueDateFmt,
        lastInvoiceId: inv.InvoiceID,
        lastInvoiceNumber: inv.InvoiceNumber,
        lastInvoiceAmount: chargeAmount + gst,
      }, { merge: true });

      results.push({ nurse: nurse.name, status: 'invoiced', invoice: inv.InvoiceNumber });
    } catch (e) {
      const detail = e.response ? JSON.stringify(e.response.data) : e.message;
      console.error(`Billing failed for ${nurse.name}:`, detail);
      results.push({ nurse: nurse.name, status: 'error', error: detail });
    }
  }
  return results;
}

exports.monthlyBillingRun = onSchedule(
  { schedule: '0 22 * * *', timeZone: 'Australia/Brisbane', secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET] },
  async () => {
    try {
      const configDoc = await db.collection('billing').doc('config').get();
      if (!configDoc.exists) return;
      const billingDay = configDoc.data().billingDay;
      if (!billingDay) return;

      const dayInBrisbane = parseInt(
        new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric' }).format(new Date()), 10
      );
      if (dayInBrisbane !== billingDay) return;

      console.log(`Billing day ${billingDay} matched — running invoices`);
      const results = await runBillingForAllNurses();
      console.log('Billing run complete', JSON.stringify(results));
    } catch (e) {
      console.error('Scheduled billing run failed:', e.message);
    }
  }
);

exports.syncBillingStatus = onCall(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET] },
  async () => {
    try {
      const token = await getXeroToken();
      const tenantId = await getXeroTenantId();
      const snap = await db.collection('billingPayments')
        .where('status', 'in', ['PENDING', 'OVERDUE']).get();
      const results = [];
      for (const doc of snap.docs) {
        const data = doc.data();
        if (!data.xeroInvoiceId) continue;
        try {
          const invRes = await axios.get(`${XERO_API_BASE}/Invoices/${data.xeroInvoiceId}`, {
            headers: { Authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId },
          });
          const inv = invRes.data.Invoices[0];
          const xeroStatus = inv.Status;
          if (xeroStatus !== data.status) {
            const update = { status: xeroStatus };
            if (xeroStatus === 'PAID') update.paidDate = new Date().toISOString().split('T')[0];
            await doc.ref.update(update);
            await db.collection('billing').doc(data.nurseId).set({
              status: xeroStatus === 'PAID' ? 'PAID' : xeroStatus === 'VOIDED' ? 'VOIDED' : 'OVERDUE',
              ...(xeroStatus === 'PAID' ? { lastPaidDate: new Date().toISOString().split('T')[0] } : {}),
            }, { merge: true });
            results.push({ nurse: data.nurseName, from: data.status, to: xeroStatus });
          }
        } catch (e) {
          console.warn('syncBillingStatus: failed for', data.nurseName, e.message);
        }
      }
      return { success: true, updated: results.length, results };
    } catch (e) {
      throw new HttpsError('internal', e.message);
    }
  }
);

exports.triggerBillingNow = onCall(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET] },
  async () => {
    try {
      const results = await runBillingForAllNurses();
      return { success: true, results };
    } catch (e) {
      const detail = e.response ? JSON.stringify(e.response.data) : e.message;
      console.error('triggerBillingNow fatal error:', detail);
      throw new HttpsError('internal', detail);
    }
  }
);

// ── XERO WEBHOOK ───────────────────────────────────────────────

exports.xeroWebhook = onRequest(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_WEBHOOK_KEY], invoker: 'public' },
  async (req, res) => {
    try {
      const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
      const signature = req.headers['x-xero-signature'];
      const webhookKey = XERO_WEBHOOK_KEY.value();

      if (webhookKey && signature) {
        const expected = crypto.createHmac('sha256', webhookKey).update(rawBody).digest('base64');
        if (signature !== expected) { res.status(401).send('Invalid signature'); return; }
      }

      const events = (req.body && req.body.events) ? req.body.events : [];
      for (const event of events) {
        if (event.resourceType !== 'INVOICE' || event.eventType !== 'UPDATE') continue;
        const invoiceId = event.resourceId;
        if (!invoiceId) continue;

        try {
          const token = await getXeroToken();
          const tenantId = await getXeroTenantId();
          const invRes = await axios.get(`${XERO_API_BASE}/Invoices/${invoiceId}`, {
            headers: { Authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId },
          });
          const inv = invRes.data.Invoices[0];
          const xeroStatus = inv.Status;

          const payments = await db.collection('billingPayments').where('xeroInvoiceId', '==', invoiceId).get();
          for (const doc of payments.docs) {
            const update = { status: xeroStatus };
            if (xeroStatus === 'PAID') update.paidDate = new Date().toISOString().split('T')[0];
            await doc.ref.update(update);
            const nurseId = doc.data().nurseId;
            await db.collection('billing').doc(nurseId).set({
              status: xeroStatus === 'PAID' ? 'PAID' : (xeroStatus === 'VOIDED' ? 'VOIDED' : 'OVERDUE'),
              ...(xeroStatus === 'PAID' ? { lastPaidDate: new Date().toISOString().split('T')[0] } : {}),
            }, { merge: true });
          }
        } catch (innerErr) {
          console.warn('Webhook invoice update failed:', innerErr.message);
        }
      }
      res.status(200).send('OK');
    } catch (e) {
      console.error('Webhook handler error:', e.message);
      res.status(500).send('Error');
    }
  }
);

// ── STATUS ENDPOINT ────────────────────────────────────────────

exports.xeroStatus = onRequest({ invoker: 'public' }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const doc = await db.collection('billing').doc('config').get();
    if (!doc.exists || !doc.data().xeroConnected) { res.json({ connected: false }); return; }
    res.json({ connected: true, organisation: doc.data().xeroTenantName || '' });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});
