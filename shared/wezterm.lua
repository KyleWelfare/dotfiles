local wezterm = require ("wezterm")
local act = wezterm.action
local config = wezterm.config_builder()

local is_windows = wezterm.target_triple:find("windows") ~= nil

-- Keybind modifiers, mapped by physical key position:
--   Mac Command -> Windows Alt (key nearest the spacebar)
--   Mac Ctrl    -> Windows Ctrl
-- Pane-nav uses CTRL|SHIFT on Windows because Windows reserves Win+Arrow for
-- Snap Layouts and intercepts it before WezTerm sees it.
local MOD = is_windows and "ALT" or "CMD"
local PANE_NAV = is_windows and "CTRL|SHIFT" or "CMD|OPT"

if is_windows then
  -- Default to PowerShell 7. Git Bash stays reachable from the launch menu for the
  -- occasional POSIX script; full path because bash.exe isn't on PATH by default.
  config.default_prog = { 'pwsh.exe', '-NoLogo' }
  config.launch_menu = {
    { label = 'PowerShell 7', args = { 'pwsh.exe', '-NoLogo' } },
    { label = 'Git Bash',     args = { 'C:\\Program Files\\Git\\bin\\bash.exe', '-l' } },
    { label = 'cmd',          args = { 'cmd.exe' } },
  }
end

-- resurrect.wezterm: persists workspace layout (windows/tabs/panes + cwd) to
-- disk so it can be restored after a full restart. Note: a reboot kills the
-- actual processes — only the layout and working dirs come back, not running
-- programs.
local resurrect = wezterm.plugin.require("https://github.com/MLFlexer/resurrect.wezterm")
resurrect.state_manager.periodic_save({ interval_seconds = 900 })

-- resurrect only auto-restores the workspace named in its "current_state"
-- pointer file, and the plugin never writes that file itself — so we point it
-- at the active workspace after every periodic save. Without this the
-- gui-startup restore below would find nothing to restore.
wezterm.on("resurrect.state_manager.periodic_save.finished", function()
  resurrect.state_manager.write_current_state(wezterm.mux.get_active_workspace(), "workspace")
end)

-- WezTerm has no quit/close event, so save whenever a window loses focus. This
-- captures the layout right before quit (which defocuses first) and avoids
-- losing up to 15 min of drift between periodic saves.
wezterm.on("window-focus-changed", function(window, pane)
  if not window:is_focused() then
    resurrect.state_manager.save_state(resurrect.workspace_state.get_workspace_state())
    resurrect.state_manager.write_current_state(window:active_workspace(), "workspace")
  end
end)

-- Zoomed-pane warning: it's easy to fullscreen a pane (MOD+Shift+Enter) and
-- later forget the tab still has other panes hidden behind it. Surface a
-- persistent badge whenever any pane in the active tab is zoomed, and force the
-- tab bar to stay visible while zoomed so the badge shows even for a single-tab
-- window (which normally hides the bar on Mac).
local zoom_state = {}

-- Accent-colored full-window border, shown only while a pane is zoomed, as a
-- peripheral-vision cue on top of the badge. base_frame is the single source of
-- truth for the window frame so the zoom override can extend it without
-- duplicating the titlebar colors.
local base_frame = {
  font = wezterm.font("Hack Nerd Font", { weight = "Bold" }),
  active_titlebar_bg = "#181825",   -- mantle
  inactive_titlebar_bg = "#181825",
}
local function zoomed_frame()
  local f = {}
  for k, v in pairs(base_frame) do f[k] = v end
  f.border_left_width = "0.5cell"
  f.border_right_width = "0.5cell"
  f.border_top_height = "0.25cell"
  f.border_bottom_height = "0.25cell"
  f.border_left_color = "#ff2d95"
  f.border_right_color = "#ff2d95"
  f.border_top_color = "#ff2d95"
  f.border_bottom_color = "#ff2d95"
  return f
end
-- set_right_status only redraws the tab bar when the string changes, so while a
-- Claude tab is working, alternate a zero-width space to force a redraw per tick.
-- The fast tick only runs while something is working; idle windows keep the base interval.
local CLAUDE_TICK_MS = 125
local redraw_tick = {}
local fast_tick = {}
local function any_claude_working(window)
  for _, t in ipairs(window:mux_window():tabs()) do
    for _, p in ipairs(t:panes()) do
      if p:get_user_vars().claude_waiting == "2" then return true end
    end
  end
  return false
end
wezterm.on("update-status", function(window)
  local tab = window:mux_window():active_tab()
  if tab == nil then return end
  local zoomed = false
  for _, p in ipairs(tab:panes_with_info()) do
    if p.is_zoomed then
      zoomed = true
      break
    end
  end
  local id = window:window_id()
  if zoom_state[id] ~= zoomed then
    zoom_state[id] = zoomed
    local overrides = window:get_config_overrides() or {}
    overrides.hide_tab_bar_if_only_one_tab = not is_windows and not zoomed
    overrides.window_frame = zoomed and zoomed_frame() or nil
    window:set_config_overrides(overrides)
  end
  local badge = zoomed and wezterm.format({
    { Attribute = { Intensity = "Bold" } },
    { Foreground = { Color = "#1e1e2e" } },
    { Background = { Color = "#ff2d95" } },
    { Text = " 🔍 PANE ZOOMED " },
  }) or ""
  local working = any_claude_working(window)
  if fast_tick[id] ~= working then
    fast_tick[id] = working
    local overrides = window:get_config_overrides() or {}
    overrides.status_update_interval = working and CLAUDE_TICK_MS or nil
    window:set_config_overrides(overrides)
  end
  if working then
    redraw_tick[id] = not redraw_tick[id]
    if redraw_tick[id] then badge = badge .. "\u{200B}" end
  end
  window:set_right_status(badge)
end)

-- Claude Code sessions flag their pane via the claude_waiting user var
-- (~/.claude/hooks/wezterm-flag.sh): 2 = working (prompt submit / tool use),
-- 1 = needs you (Notification/Stop), 0 = clear (session end). Inactive tabs show
-- a scrolling wave while working, near-white until a waiting tab is viewed, then muted
-- until the pane re-flags.
local claude_seen = {}
local function claude_state(tab)
  local state = nil
  for _, p in ipairs(tab.panes) do
    local v = p.user_vars.claude_waiting
    if v == "1" and not claude_seen[p.pane_id] then return "unseen" end
    if v == "2" then state = "working"
    elseif v == "1" and state == nil then state = "seen" end
  end
  return state
end

local claude_tab_colors = {
  unseen  = { bg = "#cdd6f4", fg = "#11111b", dot = "#e5243b", mark = "●" },  -- near-white, red dot
  seen    = { bg = "#45475a", fg = "#cdd6f4", dot = "#f38ba8", mark = "○" },  -- surface1, red ring
  working = { bg = "#313244", fg = "#cdd6f4", wave = "#cba6f7" },  -- mauve wave on surface0
}

-- One height step per frame (frame = CLAUDE_TICK_MS), so the wave
-- scrolls smoothly at a low redraw rate instead of jumping between phases.
local wave_pattern = { "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂" }
local function claude_wave(cells)
  local t = tonumber(wezterm.time.now():format("%s%.3f")) or os.time()
  local frame = math.floor(t * 1000 / CLAUDE_TICK_MS)
  local out = {}
  for i = 1, cells do
    out[i] = wave_pattern[(i - frame) % #wave_pattern + 1]
  end
  return table.concat(out)
end

wezterm.on("format-tab-title", function(tab)
  if tab.is_active then
    for _, p in ipairs(tab.panes) do
      if p.user_vars.claude_waiting == "1" then claude_seen[p.pane_id] = true end
    end
    return nil
  end
  local state = claude_state(tab)
  local c = claude_tab_colors[state]
  if not c then return nil end
  local title = tab.tab_title ~= "" and tab.tab_title or tab.active_pane.title
  if state == "working" then
    return {
      { Background = { Color = c.bg } },
      { Foreground = { Color = c.wave } },
      { Text = " " .. claude_wave(4) .. " " },
      { Foreground = { Color = c.fg } },
      { Text = title .. " " },
    }
  end
  if state == "seen" then
    return {
      { Background = { Color = c.bg } },
      { Foreground = { Color = c.fg } },
      { Text = " " .. (tab.tab_index + 1) .. ": " .. title .. " " },
      { Foreground = { Color = c.dot } },
      { Text = c.mark .. " " },
    }
  end
  return {
    { Background = { Color = c.bg } },
    { Foreground = { Color = c.dot } },
    { Text = " " .. c.mark .. " " },
    { Foreground = { Color = c.fg } },
    { Text = title .. " " },
  }
end)

-- Toast only on the 0->1 transition, since Stop and idle_prompt both fire for one turn.
local last_claude_flag = {}
wezterm.on("user-var-changed", function(window, pane, name, value)
  if name ~= "claude_waiting" then return end
  local id = pane:pane_id()
  local was = last_claude_flag[id]
  last_claude_flag[id] = value
  if value ~= "1" or was == "1" then
    if value ~= "1" then claude_seen[id] = nil end
    return
  end
  claude_seen[id] = nil
  if window:is_focused() and window:active_pane():pane_id() == id then return end
  window:toast_notification("Claude needs you", pane:get_title(), nil, 5000)
end)

-- ui
config.color_scheme = "Catppuccin Mocha"
config.font = wezterm.font("Hack Nerd Font", { weight = "Regular" })

config.enable_tab_bar = true
config.hide_tab_bar_if_only_one_tab = not is_windows
config.window_decorations = "RESIZE"
config.window_frame = base_frame

-- Tab bar: the default fancy tab bar derives the active tab background from the
-- color scheme's near-black background, which reads as an ugly solid block.
-- Override with explicit Catppuccin Mocha palette colors instead.
config.colors = {
  tab_bar = {
    background = "#181825",             -- mantle (frame behind tabs)
    active_tab = {
      bg_color = "#89b4fa",            -- blue accent
      fg_color = "#11111b",            -- crust (dark text on accent)
      intensity = "Bold",
    },
    inactive_tab = {
      bg_color = "#313244",            -- surface0
      fg_color = "#a6adc8",            -- subtext0
    },
    inactive_tab_hover = {
      bg_color = "#45475a",            -- surface1
      fg_color = "#cdd6f4",            -- text
      italic = false,
    },
    new_tab = {
      bg_color = "#181825",
      fg_color = "#a6adc8",
    },
    new_tab_hover = {
      bg_color = "#45475a",
      fg_color = "#cdd6f4",
    },
  },
}

config.inactive_pane_hsb = {
  saturation = 0.0,
  brightness = 0.5,
}

config.window_background_opacity = 1.0
config.macos_window_background_blur = 100
config.font_size = 18.0
config.window_frame.font_size = 13.0

-- On startup, restore the last saved session; if there's no saved state yet
-- (first run / restore failed) fall back to a fresh window. Either way,
-- maximize whatever window(s) we end up with.
wezterm.on("gui-startup", function(cmd)
  local ok = resurrect.state_manager.resurrect_on_gui_startup()
  if not ok then
    wezterm.mux.spawn_window(cmd or {})
  end
  for _, mux_win in ipairs(wezterm.mux.all_windows()) do
    local gui_win = mux_win:gui_window()
    if gui_win then
      gui_win:maximize()
    end
  end
end)

-- starting window size (columns x rows) — used only for windows opened
-- after startup (e.g. MOD+N); the first window is maximized above.
config.initial_cols = 160
config.initial_rows = 44

-- A pane's directory as a path to spawn in. On Windows the URL's path is "/C:/...", so drop the
-- leading slash.
local function pane_cwd(pane)
  local cwd = pane:get_current_working_dir()
  cwd = cwd and (cwd.file_path or tostring(cwd):gsub("^file://[^/]*", "")) or wezterm.home_dir
  return is_windows and cwd:gsub("^/(%a:)", "%1") or cwd
end

-- Dashboard tab: today's work log across the top, a file tree on the left and Claude in the
-- rest, all rooted at the current pane's directory. Runs the worklog-dash app from this repo.
local DASH = wezterm.home_dir .. "/dotfiles/shared/worklog-dash"
local function open_dashboard(win, pane)
  local cwd = pane_cwd(pane)
  local tab, main = win:mux_window():spawn_tab { cwd = cwd }
  tab:set_title("dash: " .. (cwd:match("([^/\\]+)[/\\]?$") or cwd))
  -- The pane stays open showing why if the app exits.
  local dash_args = is_windows
    and { "pwsh.exe", "-NoLogo", "-NoProfile", "-Command",
          "Set-Location '" .. DASH .. "'; bun index.tsx; Read-Host \"worklog-dash exited ($LASTEXITCODE), Enter closes\"" }
    -- A login shell for PATH (gh); it cds itself because the split's cwd doesn't reach it.
    or { "/bin/zsh", "-lc", "cd " .. DASH .. " && ~/.bun/bin/bun index.tsx; echo \"worklog-dash exited ($?), Enter closes\"; read" }
  main:split { direction = "Top", size = 0.28, top_level = true, cwd = DASH, args = dash_args }
  main:split {
    direction = "Left", size = 0.22, cwd = cwd,
    args = { is_windows and "broot.exe" or "/opt/homebrew/bin/broot", "--conf", DASH .. "/broot.hjson", cwd },
  }
  main:activate()
  -- The first prompt starts the worklog/Jira sync loop.
  main:send_text('claude "/loop 10m /sync-day"\r')
end

-- Per-machine settings from shared/setup.ts. Read when used, so a rerun applies without a reload.
local function local_settings()
  local f = io.open(wezterm.home_dir .. "/.config/dotfiles/local.json", "r")
  if not f then return {} end
  local ok, parsed = pcall(wezterm.json_parse, f:read("a"))
  f:close()
  return ok and type(parsed) == "table" and parsed or {}
end

-- Repo picker for the dashboard's file tree: re-roots the tab's broot pane at the chosen repo
-- or worktree, so one dash tab covers every repo. The folders are local.json's repoGlobs.
local function repo_choices()
  local home = wezterm.home_dir
  local choices = {}
  for _, glob in ipairs(local_settings().repoGlobs or {}) do
    local pattern = (glob:sub(1, 1) == "~" and home .. glob:sub(2) or glob) .. "/.git"
    for _, git in ipairs(wezterm.glob(pattern)) do
      local repo = git:gsub("[/\\]%.git$", "")
      local label = repo:sub(1, #home) == home and "~" .. repo:sub(#home + 1) or repo
      table.insert(choices, { id = repo, label = label })
    end
  end
  table.sort(choices, function(a, b) return a.label:lower() < b.label:lower() end)
  return choices
end
local function tree_pane(tab)
  for _, p in ipairs(tab:panes()) do
    local name = p:get_foreground_process_name() or ""
    if name:match("broot$") or name:match("broot%.exe$") then return p end
  end
end
local function pick_tree_repo(win, pane)
  local tree = tree_pane(pane:tab())
  if not tree then
    win:toast_notification("wezterm", "no broot file tree in this tab", nil, 2000)
    return
  end
  local choices = repo_choices()
  if #choices == 0 then
    win:toast_notification("wezterm", "no repos: set repo folders with bun ~/dotfiles/shared/setup.ts", nil, 4000)
    return
  end
  win:perform_action(act.InputSelector {
    title = "File tree repo",
    fuzzy = true,
    choices = choices,
    action = wezterm.action_callback(function(_, _, id)
      if not id then return end
      -- Esc clears a half-typed filter; sent with the command, broot reads it all as a filter.
      tree:send_text("\x1b")
      wezterm.sleep_ms(200)
      tree:send_text(":focus " .. id .. "/\r")
    end),
  }, pane)
end

-- Keybinds. The Keybinds table in README.md lists these; keep it in step.
config.keys = {
  -- Splits (iTerm2: Cmd+D / Cmd+Shift+D)
  { key = "d", mods = MOD,            action = act.SplitHorizontal { domain = "CurrentPaneDomain" } },
  { key = "d", mods = MOD .. "|SHIFT", action = act.SplitVertical   { domain = "CurrentPaneDomain" } },
  { key = "w", mods = MOD,            action = act.CloseCurrentPane { confirm = true } },
  { key = "w", mods = MOD .. "|SHIFT", action = act.CloseCurrentTab { confirm = true } },  -- whole tab, e.g. a dash tab
  { key = "Enter", mods = MOD .. "|SHIFT", action = act.TogglePaneZoomState },  -- fullscreen one pane

  -- Move between panes
  { key = "LeftArrow",  mods = PANE_NAV, action = act.ActivatePaneDirection "Left" },
  { key = "RightArrow", mods = PANE_NAV, action = act.ActivatePaneDirection "Right" },
  { key = "UpArrow",    mods = PANE_NAV, action = act.ActivatePaneDirection "Up" },
  { key = "DownArrow",  mods = PANE_NAV, action = act.ActivatePaneDirection "Down" },

  -- Reorder tabs
  { key = "LeftArrow",  mods = MOD .. "|SHIFT", action = act.MoveTabRelative(-1) },
  { key = "RightArrow", mods = MOD .. "|SHIFT", action = act.MoveTabRelative(1) },

  -- Resize panes
  { key = "LeftArrow",  mods = MOD .. "|CTRL", action = act.AdjustPaneSize { "Left", 3 } },
  { key = "RightArrow", mods = MOD .. "|CTRL", action = act.AdjustPaneSize { "Right", 3 } },
  { key = "UpArrow",    mods = MOD .. "|CTRL", action = act.AdjustPaneSize { "Up", 3 } },
  { key = "DownArrow",  mods = MOD .. "|CTRL", action = act.AdjustPaneSize { "Down", 3 } },

  -- Move the active pane INTO another tab (prompt for the 0-based tab-bar
  -- index; -1 = last). WezTerm has no built-in for this, so resolve the target
  -- tab's active pane in Lua and shell out to `wezterm cli split-pane`.
  { key = "m", mods = MOD .. "|CTRL", action = act.PromptInputLine {
    description = "Move pane → tab index (0-based, -1 = last):",
    action = wezterm.action_callback(function(win, pane, line)
      local idx = tonumber(line or "")
      if not idx then return end
      local tabs = win:mux_window():tabs()
      local target = tabs[idx >= 0 and idx + 1 or #tabs + idx + 1]
      if not target then
        win:toast_notification("wezterm", "no tab at index " .. idx, nil, 2000)
        return
      end
      -- Moving a pane into its own tab splits it against itself and it vanishes.
      local dest = target:active_pane():pane_id()
      if dest == pane:pane_id() then
        win:toast_notification("wezterm", "pane is already in that tab", nil, 2000)
        return
      end
      wezterm.run_child_process {
        wezterm.executable_dir .. (is_windows and "\\wezterm.exe" or "/wezterm"), "cli", "split-pane",
        "--move-pane-id", tostring(pane:pane_id()),
        "--pane-id", tostring(dest),
        "--right",
      }
    end),
  } },

  -- Dashboard tab (work log, file tree, Claude) for the current pane's directory
  { key = "b", mods = MOD .. "|SHIFT", action = wezterm.action_callback(open_dashboard) },

  -- New tab running Claude in the current pane's directory. send_text instead of
  -- args so the shell survives when Claude exits; \r is Enter, which PowerShell needs.
  { key = "t", mods = MOD .. "|SHIFT", action = wezterm.action_callback(function(win, pane)
    local _, new_pane = win:mux_window():spawn_tab { cwd = pane_cwd(pane) }
    new_pane:send_text("claude\r")
  end) },

  -- Start Claude in the focused pane, e.g. right after a split
  { key = "c", mods = MOD .. "|SHIFT", action = act.SendString "claude\r" },

  -- Re-root the dashboard's file tree at another repo
  { key = "o", mods = MOD .. "|SHIFT", action = wezterm.action_callback(pick_tree_repo) },

  -- Command palette + workspace switcher (the "tmux sessions" replacement)
  { key = "p", mods = MOD .. "|SHIFT", action = act.ActivateCommandPalette },
  { key = "s", mods = MOD .. "|SHIFT", action = act.ShowLauncherArgs {
    flags = is_windows and "FUZZY|WORKSPACES|LAUNCH_MENU_ITEMS" or "FUZZY|WORKSPACES" } },

  -- Re-maximize the window (no title bar / button to click)
  { key = "m", mods = MOD .. "|SHIFT", action = wezterm.action_callback(function(window)
    window:maximize()
  end) },

  -- resurrect.wezterm: save the current session, and fuzzy-restore a saved one
  { key = "s", mods = MOD .. "|CTRL", action = wezterm.action_callback(function(win, pane)
    resurrect.state_manager.save_state(resurrect.workspace_state.get_workspace_state())
    resurrect.state_manager.write_current_state(win:active_workspace(), "workspace")
    win:toast_notification("wezterm", "session saved", nil, 2000)
  end) },
  { key = "r", mods = MOD .. "|CTRL", action = wezterm.action_callback(function(win, pane)
    resurrect.fuzzy_loader.fuzzy_load(win, pane, function(id, label)
      local type = string.match(id, "^([^/]+)")   -- workspace | window | tab
      id = string.match(id, "([^/]+)$")            -- strip the leading dir
      id = string.match(id, "(.+)%..+$")           -- strip the .json extension
      local opts = {
        window = win:mux_window(),
        relative = true,
        restore_text = true,
        on_pane_restore = resurrect.tab_state.default_on_pane_restore,
      }
      if type == "workspace" then
        resurrect.workspace_state.restore_workspace(resurrect.state_manager.load_state(id, "workspace"), opts)
      elseif type == "window" then
        resurrect.window_state.restore_window(pane:window(), resurrect.state_manager.load_state(id, "window"), opts)
      elseif type == "tab" then
        resurrect.tab_state.restore_tab(pane:tab(), resurrect.state_manager.load_state(id, "tab"), opts)
      end
    end)
  end) },
}

-- Mac gets Cmd+T and Cmd+1..9 from WezTerm's defaults; Windows' defaults use
-- Ctrl+Shift, so bind the Alt equivalents explicitly. 9 jumps to the last tab.
if is_windows then
  table.insert(config.keys, { key = "t", mods = MOD, action = act.SpawnTab "CurrentPaneDomain" })
  for i = 1, 9 do
    table.insert(config.keys, { key = tostring(i), mods = MOD, action = act.ActivateTab(i == 9 and -1 or i - 1) })
  end
end

-- QoL
config.scrollback_lines = 10000            -- default 3500 — small for long Claude output
config.window_padding = { left = 8, right = 8, top = 8, bottom = 8 }
config.audible_bell = "Disabled"
config.default_cursor_style = "BlinkingBar"
config.adjust_window_size_when_changing_font_size = false
config.status_update_interval = 500        -- zoomed-pane badge latency; CLAUDE_TICK_MS while a Claude tab works

-- Return config
return config
