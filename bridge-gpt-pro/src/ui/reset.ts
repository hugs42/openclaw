import { escapeAppleScriptString, runAppleScriptStrict } from "./applescript.js";

export async function resetToNewChat(newChatLabel: string): Promise<boolean> {
  const escapedLabel = escapeAppleScriptString(newChatLabel);

  const script = `
    tell application "ChatGPT" to activate
    delay 0.2

    tell application "System Events"
      tell process "ChatGPT"
        set didReset to false

        -- Strategy 1: keyboard shortcut / menu path
        try
          keystroke "n" using {command down}
          set didReset to true
        end try

        -- Strategy 2: fallback to label-based button click
        if didReset is false then
          try
            set allUIElements to entire contents of window 1
            repeat with e in allUIElements
              try
                if (role of e) is "AXButton" and (name of e) is "${escapedLabel}" then
                  click e
                  set didReset to true
                  exit repeat
                end if
              end try
            end repeat
          end try
        end if

        return didReset
      end tell
    end tell
  `;

  const result = await runAppleScriptStrict(script);
  return result.trim().toLowerCase() === "true";
}
