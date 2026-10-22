# Usage Meter for Claude (core version)

Load it: chrome://extensions -> Developer mode -> Load unpacked -> pick this folder.

## The whole idea in 3 steps
1. inject.js     (inside claude.ai) reads the usage report at the end of every reply
2. content.js    passes it to background.js, and draws the floating meter
3. background.js saves the numbers, asks claude.ai's /usage for exact ones, updates the badge, sends notifications
   popup.html/css/js just displays what background.js saved.

## Flow
reply finishes -> inject.js -> content.js -> background.js (handleReply, then refreshUsage) -> saved -> popup/widget show it

## What it shows
Session (5h), weekly and per-model usage with reset times, extra usage spend, last message cost,
messages left, toolbar badge, notifications (session reset / limit reached).

## Not included (on purpose, to keep it simple)
Multiple accounts, chat size estimate, cache timer, detection of refused sends.

## Debugging
- background: chrome://extensions -> "service worker" -> Console (lines start with [usage-meter])
- page: F12 on claude.ai -> Console
