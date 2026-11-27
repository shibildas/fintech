# Deploying to Hugging Face Spaces (Free Docker Space)

This repository includes a production-ready `Dockerfile` (`node:24-slim`, non-root UID `1000`, port `7860`) and a single-port router (`scripts/cloud-server.ts`) that serves all 4 interactive Fintech dashboards under one HTTPS URL:

- `/p1/` — Project 1 UPI Central Switch
- `/p2/` — Project 2 Merchant Payment Gateway & PCI Vault
- `/p3/` — Project 3 Consumer UPI App, Risk Engine & Disputes
- `/p4/` — Project 4 RBI Mandates, Subscriptions & Fake Clock

## 4-Step Deployment

1. **Create a new Hugging Face Space**
   - Go to [huggingface.co/new-space](https://huggingface.co/new-space).
   - Pick a Space name (e.g. `fintech-infrastructure-stack`).
   - Select **SDK: Docker** -> **Blank** template, Hardware: **CPU basic (2 vCPU, 16 GB RAM — Free)**.

2. **Push this GitHub repository to your Space**
   ```bash
   git remote add hf https://huggingface.co/spaces/<YOUR_HF_USERNAME>/<YOUR_SPACE_NAME>
   git push hf main
   ```
   *(Or link the repo using a Hugging Face Access Token with `write` scope.)*

3. **Ensure the Space `README.md` has the Docker YAML header**
   At the very top of `README.md` on the Space branch, Hugging Face expects:
   ```yaml
   ---
   title: Fintech Infrastructure Stack
   emoji: 💳
   colorFrom: blue
   colorTo: indigo
   sdk: docker
   app_port: 7860
   ---
   ```

4. **Read your dev credentials from Space Logs**
   - Open your Space's **Logs** tab once status turns **Running**.
   - Copy the printed `X-Admin-Token`, `X-Key-Id` / `API Secret`, `X-Ops-Token`, and `X-Merchant-Token` to demo all 4 dashboards live over HTTPS (`crypto.subtle` HMAC-SHA256 & Ed25519 work natively on `https://*.hf.space`).
   - Optional: set custom `P1_ADMIN_TOKEN`, `P3_OPS_TOKEN`, or `P4_MERCHANT_TOKEN` in **Settings -> Variables and secrets**.
