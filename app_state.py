"""Shared mutable runtime state for the server process.

One `state` singleton replaces the dozen module globals that app.py used to
reassign in configure() and that run.py re-exported into mcp_bridge. Both
app.py and mcp_bridge import this same object, so a value set once in
configure() is visible everywhere — no re-export step, and no
`import app as _self` late-binding workaround.

`__slots__` makes a typo'd attribute (`state.stroe = ...`) raise immediately
instead of silently creating a dead field.
"""

class State:
    """Live singletons wired up by app.configure(). All start empty."""

    __slots__ = (
        "store", "rules", "summaries", "jobs", "schedules", "router",
        "agents", "registry", "session_store", "session_engine", "config",
        "settings", "hats", "session_token",
    )

    def __init__(self):
        self.store = None
        self.rules = None
        self.summaries = None
        self.jobs = None
        self.schedules = None
        self.router = None
        self.agents = None
        self.registry = None
        self.session_store = None
        self.session_engine = None
        self.config = {}
        self.settings = None  # settings_store.SettingsStore (created in configure)
        self.hats = None      # settings_store.HatStore (created in configure)
        self.session_token = ""


state = State()
