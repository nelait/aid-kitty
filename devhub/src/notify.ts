import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";

export interface Email {
  to: string[];
  subject: string;
  text: string;
}

/** Where emails go. SMTP in production; tests pass a capturing sender. */
export interface EmailSender {
  send(email: Email): Promise<void>;
}

export class SmtpSender implements EmailSender {
  private transport: Transporter;
  constructor(
    url: string,
    private from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(email: Email) {
    await this.transport.sendMail({ from: this.from, to: email.to.join(", "), subject: email.subject, text: email.text });
  }
}

/** Without SMTP configured, emails are logged so admins can see what would have gone out. */
export class LogSender implements EmailSender {
  async send(email: Email) {
    console.log(`[email not sent: SMTP_URL is not set] to=${email.to.join(",")} subject=${JSON.stringify(email.subject)}`);
  }
}

export function emailSender(cfg: Config): EmailSender {
  return cfg.notify.smtpUrl ? new SmtpSender(cfg.notify.smtpUrl, cfg.notify.emailFrom ?? "Dev Hub <devhub@localhost>") : new LogSender();
}

export function slack(cfg: Config, text: string): void {
  const url = cfg.notify.slackWebhookUrl;
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e) => console.error("slack notify failed:", (e as Error).message));
}
