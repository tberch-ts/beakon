// functions/mailer.js
// SMTP alerts via nodemailer. If SMTP env is not set, alerts are logged instead
// (so the emulator runs without a mail provider).
import nodemailer from 'nodemailer';

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

const FROM = () => process.env.ALERT_FROM || 'Beakon Alerts <alerts@localhost>';

export async function sendAlert(to, subject, text) {
  if (!to) return;
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer:disabled] would email ${to} :: ${subject}`);
    return;
  }
  try {
    await t.sendMail({ from: FROM(), to, subject, text });
    console.log(`[mailer] sent "${subject}" to ${to}`);
  } catch (err) {
    console.error(`[mailer] failed to send to ${to}:`, err.message);
  }
}
