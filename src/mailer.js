// src/mailer.js
// Thin wrapper over nodemailer. If SMTP is not configured, mail is logged to
// the console instead of throwing, so the app still runs in dev.
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

export function isMailConfigured() {
  return Boolean(transporter);
}

export async function sendMail(to, subject, text) {
  if (!to) return false;
  if (!transporter) {
    console.log(`[mailer:disabled] would email ${to} :: ${subject}\n${text}`);
    return false;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, text });
    console.log(`[mailer] sent "${subject}" to ${to}`);
    return true;
  } catch (err) {
    console.error(`[mailer] failed to send to ${to}:`, err.message);
    return false;
  }
}

export const sendAlert = sendMail;

export async function sendVerificationEmail(to, verifyUrl, clientName) {
  return sendMail(
    to,
    `Confirm alert emails for ${clientName} — Beakon`,
    `Someone asked Beakon to send uptime and SSL alerts for "${clientName}" to this address.\n\n` +
    `Confirm by opening this link:\n${verifyUrl}\n\n` +
    `If you didn't request this, ignore this email — nothing will be sent to you.\n\n— Beakon`
  );
}
