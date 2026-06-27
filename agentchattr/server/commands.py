"""Broadcast slash-command expansion.

The chat supports a few "broadcast macro" slash commands that a human (or an
agent) can type — `/hatmaking`, `/artchallenge`, `/roastreview`, `/poetry`.
Each expands into a prompt addressed to every agent and is then posted as a
normal message (the raw command itself is suppressed).

This module owns only the expansion: given the stripped command text, the list
of agent names, and a name→color map, it returns the prompt string. It has no
dependency on the server state, the store, or the websocket layer — app.py
posts the returned text. `/continue` and `/clear` are routing/control commands,
not macros, and stay in app.py.
"""

# The broadcast macros. Membership here drives both dispatch and the
# raw-command broadcast suppression in app.py.
BROADCAST_COMMANDS = ("/hatmaking", "/artchallenge", "/roastreview", "/poetry")

_POETRY_PROMPTS = {
    "haiku": "Write a haiku about the current state of this codebase.",
    "limerick": "Write a limerick about the current state of this codebase.",
    "sonnet": "Write a sonnet about the current state of this codebase.",
}


def is_macro(cmd_word: str) -> bool:
    """True if cmd_word (the first whitespace-delimited token) is a broadcast macro."""
    return cmd_word in BROADCAST_COMMANDS


def expand(stripped: str, agent_names: list[str], agent_colors: dict[str, str]) -> str | None:
    """Expand a broadcast macro into the prompt to post, or None if not a macro.

    `stripped` is the command text with @mentions removed and lowercased.
    `agent_names` is who to address; `agent_colors` maps name -> hex (used only
    by /hatmaking).
    """
    cmd = stripped.split()[0] if stripped else ""
    mentions = " ".join(f"@{a}" for a in agent_names)

    if cmd == "/roastreview":
        return (f"{mentions} Time for a roast review! Inspect each other's work "
                "and constructively roast it.")

    if cmd == "/artchallenge":
        parts = stripped.split(None, 1)
        theme = parts[1] if len(parts) > 1 else "anything you like"
        return (
            f"{mentions} Art challenge! Create an SVG artwork with the theme: **{theme}**. "
            "Write your SVG code to a .svg file, then attach it using chat_send(image_path=...). "
            "Make it creative, keep it under 5KB. Let's see what you've got!"
        )

    if cmd == "/hatmaking":
        color_parts = ", ".join(f"{a}={agent_colors.get(a, '#888')}" for a in agent_names)
        return (
            f"{mentions} Hat making time! Design a new hat for your avatar using SVG. "
            "Use viewBox=\"0 0 32 16\" so it fits on top of a 32px avatar circle. "
            f"Background is dark (#0f0f17). Avatar colors: {color_parts}. Design for good contrast! "
            "Call chat_set_hat(sender=your_name, svg='<svg ...>...</svg>') to wear it. "
            "Be creative — top hats, party hats, crowns, propeller beanies, whatever you want!"
        )

    if cmd == "/poetry":
        parts = stripped.split(None, 1)
        form = parts[1] if len(parts) > 1 else "haiku"
        if form not in _POETRY_PROMPTS:
            form = "haiku"
        return f"{mentions} {_POETRY_PROMPTS[form]}"

    return None
