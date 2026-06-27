"""Naming / slot / color policy — pure functions over the registry's data.

Extracted from registry.py so the policy can be unit-tested in isolation.
None of these touch instance state; they take the relevant sets/maps as
arguments and return derived values. RuntimeRegistry composes them under
its lock.
"""

import colorsys


def parse_name(name: str) -> tuple[str, int]:
    """Parse 'gemini-2' -> ('gemini', 2), 'gemini' -> ('gemini', 1)."""
    if "-" in name:
        prefix, suffix = name.rsplit("-", 1)
        try:
            return prefix, int(suffix)
        except ValueError:
            pass
    return name, 1


def next_free_slot(taken: set[int], reserved: set[int]) -> int:
    """Lowest slot >= 1 that is neither taken nor reserved."""
    slot = 1
    while slot in taken or slot in reserved:
        slot += 1
    return slot


def family_conflict(name: str, own_base: str, bases: dict) -> str | None:
    """Check if `name` stomps on another family's namespace.

    Returns an error string if it conflicts, None if safe.
    Blocks: renaming claude to 'gemini', 'gemini-2', 'codex', etc.
    Allows: renaming claude to 'cudders', 'claude-prime', etc.
    """
    t_base, _ = parse_name(name)
    # If the parsed base matches a known family that isn't ours, block it
    if t_base in bases and t_base != own_base:
        return f"Name '{name}' conflicts with the {t_base} agent family"
    # Also block if the raw name exactly matches another family's base
    if name in bases and name != own_base:
        return f"Name '{name}' is a reserved agent family name"
    return None


def derive_color(base_hex: str, slot: int) -> str:
    """Derive variant color: slot 1 = base, slot N = hue/lightness shifted.

    Pattern: slot 2 = hue +25 deg, L +5%; slot 3 = hue -25 deg, L -5%; etc.
    """
    if slot == 1:
        return base_hex
    hx = base_hex.lstrip("#")
    if len(hx) != 6:
        return base_hex
    r, g, b = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)

    # Alternating hue shifts with increasing magnitude
    magnitude = ((slot - 1 + 1) // 2) * 25
    direction = 1 if slot % 2 == 0 else -1
    h = (h + direction * magnitude / 360) % 1.0
    l = max(0.15, min(0.85, l + direction * 0.05))

    r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
    return f"#{int(r2 * 255):02x}{int(g2 * 255):02x}{int(b2 * 255):02x}"


def compose_label(base_cfg: dict, base: str, slot: int, *, force_number: bool = False) -> str:
    """Display label for an instance (STATE-5 — the rule register/claim/rename/
    deregister all duplicated).

    Slot 1 uses the bare base label (the capitalized base name as fallback);
    slots >= 2 append the slot number. `force_number` numbers slot 1 too — used
    when slot 1 is renamed to ``base-1`` as a second instance registers.
    """
    base_label = base_cfg.get("label", base.capitalize())
    if slot == 1 and not force_number:
        return base_label
    return f"{base_label} {slot}"


def compose_color(base_cfg: dict, slot: int) -> str:
    """Per-slot instance color from the base config (slot 1 = base color)."""
    return derive_color(base_cfg.get("color", "#888"), slot)
