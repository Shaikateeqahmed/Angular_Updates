import { Octokit } from 'octokit';
import { GoogleGenAI } from '@google/genai';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

// Destructure environment variables safely
const {
  GEMINI_API_KEY,
  GITHUB_TOKEN,
  TEAMS_WEBHOOK_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  YOUR_PERSONAL_PHONE
} = process.env;

if (!GEMINI_API_KEY || !GITHUB_TOKEN || !TEAMS_WEBHOOK_URL) {
  console.error("Missing primary environment variables!");
  process.exit(1);
}

// Initialize SDKs
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Initialize Twilio client only if credentials are provided
const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) 
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) 
  : null;

const REPO_OWNER = 'angular';
const REPO_NAME = 'angular';
const POLL_INTERVAL = 11 * 60 * 1000; // 11 minutes (keeps Render awake!)

const processedApprovals = new Set<number>();

async function pollAngularRepo(): Promise<void> {
  console.log(`\n Scanning ${REPO_OWNER}/${REPO_NAME} for newly approved PRs...`);

  try {
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 15
    });

    const now = new Date();

    for (const pr of pullRequests) {
      if (processedApprovals.has(pr.id)) continue;

      // Check how long ago this PR was updated.
      // If it hasn't changed in the last 15 minutes, it's an old PR from a past cycle. 
      // We add it to processedApprovals directly and skip calling Gemini.
      const lastUpdatedAt = new Date(pr.updated_at);
      const differenceInMinutes = (now.getTime() - lastUpdatedAt.getTime()) / (1000 * 60);

      if (differenceInMinutes > 15) {
        processedApprovals.add(pr.id);
        continue;
      }

      const { data: reviews } = await octokit.rest.pulls.listReviews({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        pull_number: pr.number,
      });

      const hasApproval = reviews.some(review => review.state === 'APPROVED');

      if (hasApproval) {
        console.log(`Found fresh approved PR #${pr.number}: "${pr.title}"`);
        
        const diffResponse = await fetch(pr.diff_url);
        const prDiff = await diffResponse.text();

        try {
          console.log(`Analyzing impact with Gemini...`);
          const summary = await summarizePRWithGemini(pr.title, prDiff);

          if (summary === 'SKIP_NOTIFICATION') {
            console.log(`PR #${pr.number} classified as noise/minor chore. Skipping notifications.`);
          } else {
            console.log(`Important update found! Dispatching notifications...`);
            await sendToTeams(pr.title, pr.html_url, summary);
            await sendToWhatsApp(pr.title, pr.html_url, summary);
          }

          processedApprovals.add(pr.id);

        } catch (aiError: any) {
          if (aiError?.status === 429 || aiError?.message?.includes('quota') || aiError?.message?.includes('429')) {
            console.warn(`Gemini free-tier daily quota reached or rate-limited. Skipping remaining PRs for this interval.`);
            break;
          } else {
            console.error(`Error parsing PR #${pr.number} with Gemini:`, aiError?.message || aiError);
          }
        }
      }
    }
  } catch (error: any) {
    console.error('Error during poll cycle:', error?.message || error);
  }

  setTimeout(pollAngularRepo, POLL_INTERVAL);
}

async function summarizePRWithGemini(title: string, diff: string): Promise<string> {
  const truncatedDiff = diff.substring(0, 40000);

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `
      You are an expert system tracking the core evolution of Angular framework. Your job is to act as a strict content gatekeeper for an Angular Application Developer.

      PR Title: ${title}
      
      =========================================
      🔴 MANDATORY SKIP CRITERIA (Noise to a developer):
      =========================================
      If the PR contains any of the following, respond with EXACTLY the word "SKIP_NOTIFICATION":
      - Any housekeeping chores, build steps, CI/CD pipelines, Bazel, or repo scripting configs.
      - Any documentation fixes, markdown files (.md), comment updates, or typo corrections.
      - Refactoring internal private methods, renaming internal variables, or moving test files around.
      - Code format updates, linting fixes, or bumping package dependencies of dev tools.
      - Bug fixes for highly specific, edge-case internal compiler errors that don't change how apps are written.

      =========================================
      🟢 MANDATORY ACCEPT CRITERIA (Major features / developer impact):
      =========================================
      ONLY proceed and generate a summary if the PR introduces critical changes to the framework's surface area, such as:
      - **Reactivity & State**: New features or major modifications to Signals, effects, linkedSignals, or reactive primitives.
      - **Component Architecture**: Changes to component lifecycle hooks, template syntax, defer blocks, or control flow primitives (@if, @for).
      - **Performance & Rendering**: Major additions to SSR (Server-Side Rendering), Hydration engines, Zoneless execution engines, or Change Detection strategies.
      - **Core API & Routing**: New methods or breaking changes in @angular/core, @angular/common, @angular/router, @angular/forms, or @angular/compiler.
      - **Deprecations**: Explicit deprecation alerts or removal of APIs that will break code during a future upgrade.

      =========================================
      OUTPUT FORMAT INSTRUCTIONS:
      =========================================
      - If it matches the SKIP criteria, write: SKIP_NOTIFICATION
      - If it matches the ACCEPT criteria, output a highly detailed, technical summary in this exact layout:

      🚀 **MAJOR ANGULAR UPDATE DETECTED**
      
      ## 🔹 Feature Summary
      [Give a clear explanation of what this new capability or major architectural shift does]

      ## ⚡ Developer & Application Impact
      [Explain exactly how this alters day-to-day coding. Does it make things faster? Does it change component design? Is it a step toward eliminating Zone.js completely?]

      ## 🛠️ Code Blueprint & API Surface
      [Reference the specific classes, functions, files, or template syntaxes altered. Highlight code usage changes if applicable]

      Here is the complete diff:
      ${truncatedDiff}
    `,
  });

  return response.text?.trim() || 'SKIP_NOTIFICATION';
}

async function sendToTeams(title: string, url: string, summary: string): Promise<void> {
  const messageCard = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "DD0031",
    "summary": "New Approved Angular PR Summary",
    "sections": [{
        "activityTitle": `📢 **Angular PR Approved & Summarized**`,
        "activitySubtitle": `[PR #${title}](${url})`,
        "text": summary
    }]
  };

  await fetch(TEAMS_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messageCard)
  });
  
  console.log(`Summary sent to Teams!`);
}

//(Twilio Sandbox)
async function sendToWhatsApp(title: string, url: string, summary: string): Promise<void> {
  if (!twilioClient || !TWILIO_WHATSAPP_FROM || !YOUR_PERSONAL_PHONE) {
    console.log('Twilio variables missing. Skipping WhatsApp dispatch.');
    return;
  }

  try {
    const formattedMessage = `📢 *Angular PR Approved!*\n\n*Title:* ${title}\n*Link:* ${url}\n\n${summary}`;

    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: YOUR_PERSONAL_PHONE,
      body: formattedMessage
    });

    console.log(`Summary sent to WhatsApp successfully!`);
  } catch (error: any) {
    console.error('Failed to send WhatsApp message via Twilio:', error?.message || error);
  }
}

pollAngularRepo();