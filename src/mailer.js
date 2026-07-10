// src/mailer.js
// Thin wrapper over nodemailer. If SMTP is not configured, alerts are logged
// to the console instead of throwing, so the app still runs in dev.
import nodemailer from 'nodemailer';

let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const FROM = process.env.ALERT_FROM || 'Beakon Alerts <alerts@localhost>';

export async function sendAlert(to, subject, text) {
  if (!to) return;
  if (!transporter) {
    console.log(`[mailer:disabled] would email ${to} :: ${subject}\n${text}`);
    return;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, text });
    console.log(`[mailer] sent "${subject}" to ${to}`);
  } catch (err) {
    console.error(`[mailer] failed to send to ${to}:`, err.message);
  }
}
