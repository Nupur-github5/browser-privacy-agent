# Browser Agent Project State

## Current Architecture

User
→ LangChain Agent
→ Groq
→ Browser Tools
→ Playwright
→ CDP
→ Existing Chrome

## Current Features

- Connect to existing Chrome through CDP
- Inspect arbitrary webpage form fields
- Assign FIELD_ID values
- Sanitize DOM information
- Privacy classification
- Generic field filling
- Generic submit action
- Groq LLM
- LangChain agent

## Current Privacy Rules

BLOCKED:
- password
- Aadhaar
- PAN
- credit card
- CVV
- bank account
- OTP
- secrets

SENSITIVE:
- phone
- mobile
- email
- DOB
- address
- location

ALLOWED:
- other fields unless blocked/sensitive

## Current Test

Test URL:
http://127.0.0.1:8003

Test command:

Fill the form with name Jay and submit it.

## Next Improvements

1. Better active-tab detection
2. Better label extraction
3. Google Forms support
4. Generic dropdown/radio/checkbox handling
5. User profile / approved data vault
6. Stronger privacy classification
7. Confirmation before irreversible submission
8. Browser extension integration
