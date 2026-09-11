---
name: special-selection-project-report
description: Create, review, or refine Taiwanese special-selection admissions project reports and portfolios in PPTX, PDF, Word, or Markdown. Use when an applicant needs a project story, evidence selection, author-voice writing, reflection, public-demo ending, or a light edit of an existing admissions deck; do not use for ordinary class reports unrelated to admissions.
---

# Special Selection Project Report

Produce a concise applicant-owned report that lets reviewers understand why the project exists, what was built, how it became reliable and usable, and what the applicant learned.

## Start with the applicant, not the template

Recover these facts from the conversation and supplied files before asking more questions:

- Applicant name, school, grade, target department, and application year.
- Project origin: personal frustration, observed user problem, and the decision to act.
- Applicant responsibilities, collaborators, AI/Coding Agent usage, and decision ownership.
- Product workflow, technical choices, difficult failures, feedback, and iterations.
- Timeline, real screenshots, usage data, public URL, and privacy constraints.
- Desired detail level, tone, file format, and whether the request is creation, review, or micro-adjustment.

Ask only for missing information that would materially change the report. Do not repeat a long interview after the user has already supplied the facts.

## Define the one-sentence takeaway

Before arranging pages, state internally:

> The applicant identified **[real problem]**, built **[usable system]**, improved it through **[evidence and iteration]**, and developed **[new capability or judgment]**.

Every main page must advance this takeaway. Technical completeness is not the goal; reviewer comprehension is.

## Select the content

Use the following as a flexible default, not a mandatory page count:

1. **Cover:** project thesis, name, school, grade. Keep it minimal.
2. **Origin:** the applicant's actual frustration and why existing behavior was insufficient.
3. **Evolution:** a short timeline from first build to usable or public service.
4. **System overview:** only the architecture needed to understand scope and responsibility.
5. **Product:** real screenshots showing the core user journey.
6. **Key mechanism:** how the system turns input or activity into useful feedback.
7. **Hard problem:** one reliability, quality, security, or engineering challenge and its solution.
8. **Usage evidence:** dated, clearly defined content and usage metrics.
9. **Iteration:** concrete problem → change pairs based on use, testing, or feedback.
10. **Reflection:** how the applicant's way of thinking changed.
11. **Optional appendix:** only high-value engineering decisions or target-department evidence.
12. **Final access page:** clickable public URL and QR code when useful.

Move, merge, or omit pages when the story is clearer. Keep deep implementation inventories, test catalogs, responsibility checklists, and privacy procedures in an appendix only when they materially strengthen the application.

## Write in the applicant's voice

- Use direct Traditional Chinese and concrete first-person actions.
- Prefer natural titles a student could say aloud:「我不想再逐字查詢」rather than abstract slogans.
- Describe the project as work the applicant owns, not as evidence an outside analyst inspected.
- Remove file-forensics commentary, confidence grading, source limitations, and explanations of the writing process.
- Narrow unsupported claims silently. Do not surround them with defensive disclaimers.
- Never invent improved grades, learning outcomes, user praise, release dates, or causality.
- The user's final wording and manually refined version override earlier generated drafts.
- If the user asks for a「微調」, preserve their structure, visual identity, and preferred phrasing. Fix only errors, weak claims, unclear logic, and layout defects.

## Describe AI collaboration honestly

Do not erase AI/Coding Agent involvement or imply that the applicant personally wrote every line when that is untrue. Also do not reduce the applicant to a prompt sender.

Show applicant ownership through decisions:

- Defined the problem and priorities.
- Decided what the system should do.
- Set quality or acceptance rules.
- Tested outputs and rejected incorrect results.
- Chose fallbacks, fixes, and the next iteration.
- Accepted responsibility for the deployed result.

A useful pattern is:

> 我運用 AI 與 Coding Agent 協助實作，但由我決定要解決什麼、如何驗收，以及哪些結果不能直接採用。

## Keep evidence meaningful

- Give every metric a definition and snapshot date. Distinguish visitors, accounts, active users, sessions, answers, and retained records.
- Use real product screens with representative data; crop or enlarge the area that proves the page's claim.
- De-identify student names, accounts, IP addresses, and private data.
- Use safe timeline wording such as「第一版可用」「建立匯入流程」「公開部署」unless a formal release is documented.
- Show one or two specific failures and corrections instead of claiming continuous improvement abstractly.
- Do not equate system use with improved academic performance unless measured.
- If a school or application year is named, verify the current official admissions rules. Label older rules as reference and recheck when the new brochure is published.

## Build a real reflection page

Reflection must contain learning, not self-praise:

1. **Before:** what the applicant originally believed or could do.
2. **Turning point:** what failed, surprised them, or became harder after real use.
3. **Now:** the judgment or responsibility they developed.

Good reflection topics include defining problems, breaking down requirements, validating quality, designing fallbacks, maintaining a public service, and accepting consequences. Avoid generic claims such as「AI 讓我具備工程大局觀」without a concrete project experience.

## End with access, not a generic thank-you

The last page should resolve the report by inviting reviewers to use the project:

- Project name and one-sentence invitation.
- Full HTTPS URL in visible text.
- A working clickable hyperlink.
- QR code when the report will be printed or presented.
- No credentials, private administrator entrance, or sensitive instructions.

Verify the public page before delivery when browsing is available. If it is unavailable, keep the user-provided URL without claiming it was tested.

## Visual and editorial rules

- Reuse a supplied deck's design instead of rebuilding it from a generic theme.
- Keep one claim per page, large readable titles, and low-density body copy.
- Avoid repeated card grids, English labels, slogans, and conclusion footers when they make the report look templated.
- Prefer two or three readable screenshots over many tiny screenshots.
- Shorten copy before reducing font size.
- Do not leave blank placeholders, clipped titles, unreadable tables, inconsistent page numbers, or a missing final link.

## Delivery checks

Before handoff:

1. Read the report once as an admissions reviewer: can the project be understood without narration?
2. Read it again as the applicant: does it sound like something they would intentionally say?
3. Confirm names, dates, metrics, terminology, and target-school rules.
4. Confirm AI collaboration is accurate and neither hidden nor overstated.
5. Render and inspect every page; fix overflow, clipping, wrapping, tiny screenshots, and broken hierarchy.
6. Test hyperlinks and confirm the final access page exists.
7. Preserve the user's source file and export an edited copy unless they explicitly request an in-place update.
8. Deliver only the final artifact and a short summary of material changes.

