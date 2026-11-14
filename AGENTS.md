
# WARP.md — Nexus Engineering Rules

## 1. Project Mission

Nexus is an IDE-integrated engineering intelligence platform designed to help developers understand unfamiliar software projects and confidently contribute to them.

Its central purpose is:

**Help someone build an accurate mental model of an unfamiliar software project, then use that understanding to accomplish something.**

Nexus connects fragmented engineering knowledge, including:
- Source code
- Dependencies and relationships
- Documentation and specifications
- Tests
- Architectural decisions
- Development history

Nexus transforms these sources into an interconnected, traceable project knowledge model.

Nexus is NOT:
- A generic AI chatbot.
- A code-generation tool disguised as a knowledge platform.
- Merely a dependency graph visualizer.
- A system that requires developers to manually upload their entire project.

## 2. Primary Development Objective

Prioritize a working end-to-end prototype that demonstrates this experience:

1. A developer opens an unfamiliar repository in VS Code.
2. They activate Nexus and scan the project.
3. Nexus discovers files, components, and relationships.
4. Nexus generates an explorable project knowledge model.
5. The developer selects a component and understands its purpose and connections.
6. The developer describes a feature they want to implement.
7. Nexus identifies relevant components, files, dependencies, and tests.
8. Nexus provides evidence supporting its recommendations.

Build this experience before attempting secondary features.

## 3. Technology Stack

Use the following technologies unless an explicit architectural decision changes them.

- Language: TypeScript
- Runtime: Node.js
- IDE integration: VS Code Extension API
- AI integration: Gemini API
- Initial storage: JSON
- Version control: Git and GitHub
- Package management: npm

Prefer TypeScript throughout the initial prototype to avoid unnecessary complexity from maintaining multiple runtimes.

Do not introduce additional frameworks, databases, or services without explaining why they are needed.

## 4. Architecture Principles

Follow a modular monolith architecture.

Keep responsibilities separated into understandable modules.

Core responsibilities:

- Extension: IDE integration and commands.
- Scanner: Discovers and reads authorized project files.
- Parser: Extracts structural information from source code.
- Knowledge model: Defines components, relationships, and evidence.
- Knowledge builder: Constructs the project knowledge model.
- AI integration: Performs semantic analysis and feature-location reasoning.
- UI: Displays project knowledge and allows exploration.

Architecture rules:

- Keep modules focused on one primary responsibility.
- Define clear inputs and outputs.
- Prefer reusable functions over duplicated logic.
- Avoid unnecessary abstractions.
- Avoid premature microservices.
- Keep data structures consistent across modules.
- Do not create empty folders or speculative infrastructure.

## 5. Accuracy and Evidence

This is one of the most important requirements of Nexus.

Never allow AI-generated assumptions to appear as verified facts.

Distinguish between:

**Explicit relationships**
- Directly established by source code, imports, configuration, or other authoritative project data.

**Inferred relationships**
- Suggested by AI based on semantic interpretation.

Every important claim should have supporting evidence whenever possible.

Evidence should identify:
- Source file.
- Relevant line or section.
- Type of evidence.
- Confidence or verification status where appropriate.

If evidence is unavailable, clearly communicate uncertainty.

Never fabricate:
- Components.
- Dependencies.
- File locations.
- Functionality.
- Architectural decisions.
- Source references.

Prefer deterministic analysis for structural facts and AI-assisted analysis for semantic interpretation.

Validate AI-generated structured output before using it.

## 6. Code Quality Standards

- Use descriptive variable and function names.
- Use TypeScript interfaces and types for important data structures.
- Avoid `any` unless absolutely necessary and documented.
- Keep functions small and understandable.
- Handle errors explicitly.
- Avoid unnecessary dependencies.
- Avoid duplicated logic.
- Follow existing project conventions.
- Do not suppress errors simply to make code compile.
- Do not leave unfinished placeholder implementations while claiming functionality is complete.

Write code that another developer can understand and maintain.

## 7. Security and Privacy

Repositories being analyzed must be treated as untrusted input.

- Never execute repository code just to understand it.
- Never modify scanned project files without explicit user authorization.
- Respect `.gitignore`.
- Exclude `.env` files, credentials, private keys, and secrets.
- Exclude dependency folders, build output, binary files, and irrelevant generated files.
- Request permission before scanning a workspace.
- Respect VS Code Workspace Trust.
- Make external AI processing transparent.
- Never transmit repository contents to an external AI service without appropriate user consent.
- Do not log secrets or sensitive file contents.

Nexus should be read-only by default.

## 8. AI Agent Workflow

Before implementing a task:

1. Inspect the existing project structure.
2. Read relevant files and existing documentation.
3. Understand the current architecture.
4. Identify which modules need modification.
5. Determine whether the task introduces architectural changes.

For substantial changes, briefly present an implementation plan before proceeding.

While implementing:

- Work on the requested task only.
- Avoid unrelated refactoring.
- Preserve existing functionality.
- Reuse existing modules where appropriate.
- Do not introduce dependencies without justification.
- Do not silently change architectural decisions.
- Do not rewrite working code unnecessarily.

After implementation:

1. Run relevant tests.
2. Run TypeScript type checking.
3. Run the build or compilation command where available.
4. Inspect the Git diff.
5. Report what changed.
6. Explain important implementation decisions.
7. Identify limitations and unverified behavior.

Never claim something works unless it has actually been tested or verified.

## 9. Teaching and Communication

The project owner is learning TypeScript and software architecture while developing Nexus.

Do not assume the project owner understands every implementation detail.

When introducing unfamiliar concepts:

- Explain what the code does.
- Explain why the implementation was chosen.
- Identify its inputs and outputs.
- Explain how it connects to other modules.
- Highlight important failure cases.
- Explain unfamiliar TypeScript concepts when relevant.

Do not overwhelm the project owner with explanations of every line.

Prioritize understanding the system, module responsibilities, data flow, and architectural decisions.

Do not hide important decisions behind AI-generated code.

## 10. Git and Version Control

Git is the source of truth for project history.

Allowed without additional approval:
- Inspect Git status.
- Inspect branches and commit history.
- Review diffs.
- Edit project files.
- Run tests and build commands.

Require explicit authorization before:
- Creating commits.
- Pushing to GitHub.
- Force-pushing.
- Rewriting commit history.
- Deleting branches.
- Performing destructive Git operations.

Never commit secrets, credentials, or private configuration.

Keep changes focused and commit messages descriptive.

## 11. Scope Discipline

Prioritize the following:

1. Working VS Code extension.
2. Reliable project scanning.
3. Source-code structure extraction.
4. Project knowledge model.
5. Evidence-backed relationships.
6. AI-assisted feature-location discovery.
7. Clear, interactive IDE experience.

Do not prematurely implement:

- Microservices.
- Multi-agent systems.
- Kubernetes infrastructure.
- Distributed databases.
- Complex graph databases.
- Automatic synchronization systems.
- Enterprise administration features.

Only introduce complexity when a concrete requirement demands it.

## 12. Definition of Done

A task is not complete merely because code has been generated.

A task is complete when:

- The implementation meets its stated acceptance criteria.
- Relevant tests pass.
- TypeScript checks pass where applicable.
- Existing functionality remains intact.
- The code fits the project architecture.
- Important limitations are documented.
- The implementation can be explained to the project owner.

## 13. Final Engineering Principle

**Build the smallest reliable implementation that advances Nexus toward its mission. Prioritize correctness, traceability, and a compelling end-to-end experience over unnecessary complexity.**

You are the implementation agent, not the product owner. Follow the project's established direction, explain important technical decisions, and seek approval before making significant architectural changes.
