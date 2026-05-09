---
title: Tools
layout: default
nav_order: 4
---

# Tools
{: .no_toc }

Jennifer can take real actions using tools. The inference model decides which tool to use based on your request.

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## fetch_url

Fetches and extracts readable text from any URL.

**When Jennifer uses it:** Reading blog posts, checking APIs, fetching web pages, accessing your fridge server.

**Example queries:**
```
Ok Jennifer, read the latest post from blog.97115104.com
Ok Jennifer, what's on the menu at the fridge server?
Ok Jennifer, summarize the GitHub README at github.com/97115104/jennifer
```

**Implementation:** `src/tools/WebFetchTool.js`

---

## execute_shell

Runs shell commands on the local machine.

**When Jennifer uses it:** Creating projects, running git, building code, installing packages.

**Example queries:**
```
Ok Jennifer, create a Jekyll site in ~/Sites called steve-blog
Ok Jennifer, run git status in my jennifer project
Ok Jennifer, install the prettier npm package globally
```

{: .warning }
This tool can run any shell command. Jennifer uses it only when you explicitly ask for system actions.

**Implementation:** `src/tools/ShellTool.js`

---

## read_file

Reads a local file and returns its contents.

**When Jennifer uses it:** Reading notes, config files, code, documents.

**Example queries:**
```
Ok Jennifer, read my notes file at ~/notes.txt
Ok Jennifer, what's in my .zshrc?
```

**Implementation:** `src/tools/ReadFileTool.js`

---

## write_file

Writes content to a local file (creates directories as needed).

**When Jennifer uses it:** Creating files, saving output, generating code.

**Example queries:**
```
Ok Jennifer, write a hello world HTML page to ~/Desktop/hello.html
Ok Jennifer, save the recipe you just described to ~/recipes/pasta.txt
```

**Implementation:** `src/tools/WriteFileTool.js`

---

## send_email

Sends an email via SMTP.

**When Jennifer uses it:** Sending notifications, sharing links, delivering results.

**Requires configuration in `.env`:**
```bash
SMTP_HOST=smtp.gmail.com
SMTP_USER=you@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM=you@gmail.com
```

**Example queries:**
```
Ok Jennifer, send me an email at x@97115104.com with the GitHub link
Ok Jennifer, email steve@example.com that the deploy is done
```

**Implementation:** `src/tools/EmailTool.js`

---

## Adding Custom Tools

Create a new file in `src/tools/` following this interface:

```js
'use strict';

const MyTool = {
  name: 'my_tool',
  description: 'One-line description of what this tool does and when to use it.',
  parameters: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'What this parameter is' },
    },
    required: ['param1'],
  },

  async execute({ param1 }) {
    // ... do something
    return 'result string'; // always return a string
  },
};

module.exports = MyTool;
```

Then register it in `src/server/index.js`:

```js
const MyTool = require('../tools/MyTool');
tools.register(MyTool);
```

That's it — Jennifer will automatically include it in the next inference request.
