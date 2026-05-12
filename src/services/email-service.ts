import { Resend } from 'resend';

export interface EmailConfig {
  apiKey: string;
  fromEmail: string;
  appName: string;
  appUrl: string;
}

/**
 * Escape HTML special characters so user-controlled values (name, email)
 * can't inject markup, links, or scripts into the email body.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class EmailService {
  private resend: Resend;
  private config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
    this.resend = new Resend(config.apiKey);
  }

  async sendPasswordResetEmail(to: string, resetToken: string, userName: string): Promise<boolean> {
    const resetUrl = `${this.config.appUrl}/reset-password/${resetToken}`;
    const safeUserName = escapeHtml(userName);
    const safeAppName = escapeHtml(this.config.appName);
    const safeResetUrl = escapeHtml(resetUrl);

    try {
      const { error } = await this.resend.emails.send({
        from: `${this.config.appName} <${this.config.fromEmail}>`,
        to: [to],
        subject: `Reset your ${this.config.appName} password`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1a1a2e;">Password Reset Request</h2>
            <p>Hi ${safeUserName},</p>
            <p>We received a request to reset your password for ${safeAppName}.</p>
            <p>Click the button below to set a new password:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${safeResetUrl}"
                 style="background-color: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 500;">
                Reset Password
              </a>
            </div>
            <p style="color: #666; font-size: 14px;">
              Or copy and paste this link into your browser:<br/>
              <a href="${safeResetUrl}" style="color: #6366f1;">${safeResetUrl}</a>
            </p>
            <p style="color: #666; font-size: 14px;">
              This link will expire in 24 hours.
            </p>
            <p style="color: #999; font-size: 12px; margin-top: 40px; border-top: 1px solid #eee; padding-top: 20px;">
              If you didn't request this password reset, you can safely ignore this email.
            </p>
          </div>
        `,
        text: `
Hi ${userName},

We received a request to reset your password for ${this.config.appName}.

Click this link to set a new password:
${resetUrl}

This link will expire in 24 hours.

If you didn't request this password reset, you can safely ignore this email.
        `.trim()
      });

      if (error) {
        console.error('[EmailService] Failed to send password reset email:', error);
        return false;
      }

      console.log(`[EmailService] Password reset email sent to ${to}`);
      return true;
    } catch (err) {
      console.error('[EmailService] Error sending email:', err);
      return false;
    }
  }
}


