---
description: Guides project selection and creation before using coding tools. Follow this skill before calling claude_code, gemini_cli, or codex_cli.
---

# Project Setup

## When to Use

Before calling any coding tool (`claude_code`, `claude_code_cli`, `gemini_cli`, `codex_cli`), if no project has been set for this session, you MUST follow this skill to confirm a project with the user.

## How to Detect

If you call a coding tool and receive the error "No project has been confirmed for this session", follow the steps below.

You should also proactively follow these steps when you determine the user's request will require a coding tool, before actually calling the tool.

## Step 1: Identify the Target Project

Use the `list_files` tool to list directories in the PROJECTS folder. These are the available projects.

Try to determine the target project:
1. **Session name match**: If the session name matches a project folder name, suggest that project.
2. **Message inference**: If the user's message mentions a project name or describes a project that clearly matches one in the list, suggest that project.
3. **Ask the user**: If no clear match, list all projects and ask.

## Step 2: Confirm with the User

Present a numbered confirmation prompt:

```
Before I start coding, let me confirm which project to work on.

I found these projects in your workspace:
1. <project-a> (existing project)
2. <project-b> (existing project)
3. <project-c> (existing project)

Based on your request, I think you want to work on **<best-match>**.

Please confirm:
1. Work on **<best-match>** (existing project)
2. Start a new project
3. Work on a different project (enter project number or name)
```

If there are no existing projects, skip straight to asking if they want to create a new project.

## Step 3: Handle the Response

### If the user confirms an existing project:
Call `set_project` with `projectName: "<name>"` and `isNew: false`.

### If the user wants a new project:
Ask for the project name. Then call `set_project` with `projectName: "<name>"` and `isNew: true`.

If `set_project` returns an error saying the project already exists, inform the user:

```
A project named "<name>" already exists. Did you mean to:
1. Work on the existing "<name>" project
2. Create a new project with a different name
```

### If the user picks a different project (option 3):
They may respond with a project number from the list or type a project name. Resolve their choice and call `set_project` accordingly.

## Step 4: Proceed

After `set_project` succeeds, proceed with the original coding task.

## Switching Projects Mid-Session

If during the session the user indicates they want to work on a different project, suggest:

```
It sounds like you want to switch to project "<name>". You can:
1. Switch to "<name>" now in this session
2. Start a new session for "<name>" (recommended for clean context)
```

If they choose to switch, call `set_project` with the new project name.
