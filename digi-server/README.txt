DIGI SERVER — WINDOWS + IPHONE

This matches your existing App.tsx: POST {message, messages, pet}, return {reply}.
Python 3.10 or newer. No pip installs needed. Leave App.tsx unchanged.

1. Extract this ZIP into C:\Users\HuyTr\Projects\digi-server.
   Open that folder in File Explorer, type powershell in the address bar, Enter.

2. Test without an API key:
      py server.py --demo
   If py is unavailable, try python instead.
   Allow Python on Private networks if Windows Firewall asks.

3. Keep the laptop and iPhone on the same trusted Wi-Fi.
   In a second PowerShell window, run:
      ipconfig
   Find Wireless LAN adapter Wi-Fi -> IPv4 Address.
   Ignore VPN, virtual Ethernet and disconnected adapters.
   Example only: 192.168.1.25. Your address may be different.

4. On iPhone Safari, visit:
      http://YOUR_WIFI_IPV4:8000/health
   You should see status: ok and mode: demo.
   If it fails, check Wi-Fi, Python's Private-network firewall permission,
   and VPN/guest-network isolation. If iOS asks, allow local network access.

5. In Digi -> Settings, enter:
      http://YOUR_WIFI_IPV4:8000/chat
   Send Hello. Digi should return a clearly labeled preset demo reply.
   Do not use localhost, 127.0.0.1 or 0.0.0.0 on your iPhone.

6. Enable real AI:
   Stop demo mode with Ctrl+C. Run:
      py server.py
   Paste your OpenAI API key at the hidden prompt and press Enter.
   It is kept in this process's memory, not written to a file.
   Never paste the key into Digi's URL field or share it in chat.
   API billing/credits are required separately from a ChatGPT subscription.
   Create/manage your key at https://platform.openai.com/api-keys
   Keep the same /chat URL in Digi and send another message.

Default model: gpt-4.1-mini. If your account cannot access it, choose an
available Responses API model and set it before launching:
   $env:OPENAI_MODEL = 'YOUR_MODEL_ID'
   py server.py

Your iPhone app supplies the last 20 messages for conversational context.
The server does not save chat transcripts. Requests go to OpenAI in AI mode.
Your app already reads replies aloud when enabled. For Expo Go on iPhone,
if speech is silent, check silent mode and media volume.

TROUBLESHOOTING
- App HTTP 502: look at the laptop terminal for key/model/quota guidance.
- HTTP 504: check laptop internet access and retry.
- Request timeout: first test /health in Safari, then demo mode.
- A changing Wi-Fi IPv4 address means updating Digi's saved URL.
- A custom iOS build may require a local networking/HTTP configuration change
  and rebuild if Safari works but app requests fail. Report the exact error.
- The server must remain running and the laptop awake for replies.

SCOPE
This provides typed/dictated chat and spoken replies through your existing app.
It does not add camera access, continuous listening, or physical movement.
This unauthenticated HTTP server is only for your own trusted local Wi-Fi.
Do not port-forward it or publish it as-is. Remote use needs HTTPS and auth.

Documentation used:
https://developers.openai.com/api/docs/guides/text
https://developers.openai.com/api/docs/models/gpt-4.1-mini
