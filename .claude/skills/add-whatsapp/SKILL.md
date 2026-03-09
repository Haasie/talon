---
name: add-whatsapp
description: |
  Add WhatsApp as a channel. Use when the user says "add whatsapp",
  "connect whatsapp", "set up whatsapp", or "whatsapp channel".
triggers:
  - "add whatsapp"
  - "connect whatsapp"
  - "whatsapp channel"
  - "whatsapp business"
---

# Add WhatsApp Channel

Walk the user through adding WhatsApp Business as a channel to Talon. One question at a time.

**Important:** WhatsApp Business API requires a Meta Business Account and a verified phone number. This is more involved than Telegram or Slack.

## Phase 1: Pre-flight

Check if a whatsapp channel already exists:

```bash
npx talonctl list-channels
```

## Phase 2: Meta Business Setup

Ask: **"Do you already have a WhatsApp Business API set up with a phone number ID and access token?"**

If no, walk them through it:

> ### Prerequisites
>
> - A Meta (Facebook) Business account
> - A phone number that can receive SMS or calls for verification
>
> ### Create the App
>
> 1. Go to [developers.facebook.com](https://developers.facebook.com)
> 2. Click **My Apps** > **Create App**
> 3. Select **Business** as the app type
> 4. Fill in the app name and select your business account
>
> ### Set Up WhatsApp
>
> 1. In the app dashboard, click **Add Product** > **WhatsApp** > **Set Up**
> 2. Go to **WhatsApp** > **API Setup** in the left sidebar
> 3. You'll see a test phone number — or add your own business number
> 4. Copy:
>    - **Phone Number ID** (numeric, under the phone number)
>    - **Temporary Access Token** (for testing — generate a permanent one for production)
>
> ### Generate a Permanent Token
>
> 1. Go to **Business Settings** > **System Users**
> 2. Create a system user with Admin role
> 3. Generate a token with `whatsapp_business_messaging` permission
> 4. This token doesn't expire
>
> ### Set Up Webhook
>
> 1. Go to **WhatsApp** > **Configuration**
> 2. Set the webhook URL to your server's endpoint (e.g. `https://your-server.com/webhook/whatsapp`)
> 3. Set a **Verify Token** (any string you choose — you'll use this in config)
> 4. Subscribe to the `messages` webhook field

Wait for the user to provide: phone number ID, access token, and verify token.

## Phase 3: Add the Channel

Ask for a channel name (suggest `my-whatsapp`), then:

```bash
npx talonctl add-channel --name <name> --type whatsapp
```

Then edit `talond.yaml` to set the config section:

```yaml
config:
  phoneNumberId: "123456789"
  accessToken: ${WHATSAPP_ACCESS_TOKEN}
  verifyToken: ${WHATSAPP_VERIFY_TOKEN}
```

Tell the user to add to `.env`:

```
WHATSAPP_ACCESS_TOKEN=your-access-token
WHATSAPP_VERIFY_TOKEN=your-verify-token
```

## Phase 4: Bind a Persona

```bash
npx talonctl list-personas
```

Ask which persona to bind, then:

```bash
npx talonctl bind --persona <name> --channel <channel-name>
```

## Phase 5: Validate

```bash
npx talonctl env-check
npx talonctl doctor
```

## Phase 6: Verify

Tell the user:

> 1. Make sure talond is running (or restart it)
> 2. Make sure your webhook endpoint is publicly accessible (use ngrok for testing)
> 3. Send a WhatsApp message to the business number
> 4. You should get a response within a few seconds

If it doesn't work:

```bash
# Check logs
journalctl --user -u talond -f

# Test webhook verification
curl "https://your-server.com/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=test"
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Webhook verification fails | Check `verifyToken` matches what's in Meta App Dashboard |
| Messages not arriving | Ensure webhook URL is publicly accessible and subscribed to `messages` |
| "Invalid OAuth access token" | Token expired — generate a permanent one via System Users |
| Bot responds but user doesn't see it | Check WhatsApp message template approval (for outbound-first messages) |
| Only text messages work | Normal — Talon v1 supports text only; media messages are logged but skipped |

## Config Reference

```yaml
channels:
  - name: my-whatsapp
    type: whatsapp
    config:
      phoneNumberId: "123456789"               # Required
      accessToken: ${WHATSAPP_ACCESS_TOKEN}    # Required
      verifyToken: ${WHATSAPP_VERIFY_TOKEN}    # Required — must match Meta dashboard
      apiVersion: "v18.0"                      # Optional (default: v18.0)
```

## How It Works

- Inbound messages arrive via Meta webhook — your server needs a public HTTPS endpoint
- Outbound messages use the WhatsApp Cloud API (Graph API)
- Each sender's phone number maps to one Talon thread
- Only text messages are processed in v1 (images, audio, etc. are logged and skipped)
- For testing without a public server, use ngrok: `ngrok http 3000`
