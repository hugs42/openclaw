import { BridgeError } from "../errors.js";
import { runAppleScriptStrict } from "./applescript.js";

export interface ScrapeOptions {
  includeDescriptions?: boolean;
  timeoutMs?: number;
}

export async function scrapeConversationText(options: ScrapeOptions = {}): Promise<string> {
  const includeDescriptions = options.includeDescriptions ? "true" : "false";

  const script = `
    tell application "System Events"
      if not (application process "ChatGPT" exists) then
        return "__APP_NOT_RUNNING__"
      end if
    end tell

    tell application "System Events"
      tell process "ChatGPT"
        if not (exists window 1) then
          return "__NO_WINDOW__"
        end if

        set frontWin to front window
        set allUIElements to entire contents of frontWin
        set conversationText to {}

        repeat with e in allUIElements
          try
            if (role of e) is "AXStaticText" then
              set itemText to description of e
              if itemText is not missing value and itemText is not "" then
                set end of conversationText to itemText
              end if
            end if

            if ${includeDescriptions} then
              if exists (attribute "AXDescription" of e) then
                set elementDescription to value of attribute "AXDescription" of e
                if elementDescription is not missing value and elementDescription is not "" then
                  set end of conversationText to elementDescription
                end if
              end if
            end if
          end try
        end repeat

        if (count of conversationText) is 0 then
          return ""
        end if

        set AppleScript's text item delimiters to linefeed
        return conversationText as text
      end tell
    end tell
  `;

  const result = await runAppleScriptStrict(script, { timeoutMs: options.timeoutMs });

  if (result === "__APP_NOT_RUNNING__") {
    throw new BridgeError("app_not_running", "ChatGPT app is not running");
  }

  if (result === "__NO_WINDOW__") {
    throw new BridgeError("ui_element_not_found", "No ChatGPT window found");
  }

  return result;
}
