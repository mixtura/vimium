import * as testHelper from "./test_helper.js";
import "../../tests/unit_tests/test_chrome_stubs.js";
import { Suggestion } from "../../background_scripts/completion/completers.js";
import * as vomnibarPage from "../../pages/vomnibar_page.js";

function newKeyEvent(properties) {
  return Object.assign(
    {
      type: "keydown",
      key: "a",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      stopImmediatePropagation: function () {},
      preventDefault: function () {},
    },
    properties,
  );
}

context("vomnibar page", () => {
  let ui;
  setup(async () => {
    await testHelper.jsdomStub("pages/vomnibar_page.html");
    stub(chrome.runtime, "sendMessage", async (message) => {
      if (message.handler == "filterCompletions") {
        return [];
      }
    });
    vomnibarPage.reset();
    await vomnibarPage.activate();
    ui = vomnibarPage.ui;
  });

  should("hide when escape is pressed", async () => {
    ui.setQuery("www.example.com");
    // Here we assert that the dialog has been reset when esc is pressed, which happens as part of
    // hiding the dialog. It would be better to check more directly that the dialog was hidden, but
    // jacking into the channels for this are not worthwhile for this test.
    await ui.onKeyEvent(newKeyEvent({ key: "Escape" }));
    assert.equal("", ui.input.value);
  });

  should("edit a completion's URL when ctrl-enter is pressed", async () => {
    stub(chrome.runtime, "sendMessage", async (message) => {
      if (message.handler == "filterCompletions") {
        const s = new Suggestion({ url: "http://hello.com" });
        return [s];
      }
    });
    await ui.update();
    await ui.onKeyEvent(newKeyEvent({ type: "keydown", key: "up" }));
    // TODO(philc): Why does this need to be lowercase enter?
    await ui.onKeyEvent(newKeyEvent({ type: "keypress", ctrlKey: true, key: "enter" }));
    assert.equal("http://hello.com", ui.input.value);
  });

  should("close a selected tab when ctrl-d is pressed and refill the list", async () => {
    let removedTabId = null;
    let wasRemoved = false;
    stub(chrome.runtime, "sendMessage", async (message) => {
      if (message.handler == "filterCompletions") {
        if (!wasRemoved) {
          return [
            {
              description: "tab",
              html: "<span>tab 1</span>",
              tabId: 42,
              title: "tab 1",
              url: "https://example.com/1",
            },
            {
              description: "tab",
              html: "<span>tab 2</span>",
              tabId: 43,
              title: "tab 2",
              url: "https://example.com/2",
            },
          ];
        }
        return [
          {
            description: "tab",
            html: "<span>tab 2</span>",
            tabId: 43,
            title: "tab 2",
            url: "https://example.com/2",
          },
          {
            description: "tab",
            html: "<span>tab 3</span>",
            tabId: 44,
            title: "tab 3",
            url: "https://example.com/3",
          },
        ];
      } else if (message.handler == "removeSpecificTab") {
        removedTabId = message.id;
        wasRemoved = true;
      }
    });

    vomnibarPage.reset();
    await vomnibarPage.activate({ completer: "tabs", selectFirst: true });
    ui = vomnibarPage.ui;

    await ui.onKeyEvent(newKeyEvent({ key: "d", ctrlKey: true }));

    assert.equal(42, removedTabId);
    assert.equal([43, 44], ui.completions.map((c) => c.tabId));
    assert.equal(0, ui.selection);
  });

  should("request all matching tabs for tab selection", async () => {
    let filterRequest = null;
    stub(chrome.runtime, "sendMessage", async (message) => {
      if (message.handler == "filterCompletions") {
        filterRequest = message;
        return [];
      }
    });

    vomnibarPage.reset();
    await vomnibarPage.activate({ completer: "tabs", maxResults: Number.MAX_SAFE_INTEGER });

    assert.equal("tabs", filterRequest.completerName);
    assert.equal(Number.MAX_SAFE_INTEGER, filterRequest.maxResults);
  });

  should("assign the selected tab to a group and return to tab search when ctrl-a is pressed", async () => {
    const filterRequests = [];
    let assignedTabId = null;
    let assignedGroupId = null;
    let assignmentCount = 0;
    stub(chrome.runtime, "sendMessage", async (message) => {
      if (message.handler == "filterCompletions") {
        filterRequests.push(message);
        if (message.completerName == "tabs") {
          return [
            {
              description: "tab",
              html: "<span>docs</span>",
              tabId: 42,
              title: "docs",
              url: "https://example.com/docs",
              tabGroupTitle: assignmentCount > 0 ? "Work" : null,
              tabGroupColor: assignmentCount > 0 ? "blue" : null,
            },
          ];
        } else if (message.completerName == "tabGroups") {
          return [
            {
              description: "tab group",
              html: "<span>Work</span>",
              tabGroupId: 12,
              tabGroupTitle: "Work",
              tabGroupColor: "blue",
              title: "Work",
              url: "group:12",
            },
          ];
        }
      } else if (message.handler == "assignTabToGroup") {
        assignedTabId = message.tabId;
        assignedGroupId = message.groupId;
        assignmentCount += 1;
      }
    });

    vomnibarPage.reset();
    await vomnibarPage.activate({ completer: "tabs", query: "docs", selectFirst: true });
    ui = vomnibarPage.ui;

    await ui.onKeyEvent(newKeyEvent({ key: "a", ctrlKey: true }));

    assert.equal("tabGroups", ui.completerName);
    assert.equal("", ui.input.value);
    assert.equal("tabGroups", filterRequests.at(-1).completerName);

    await ui.onKeyEvent(newKeyEvent({ type: "keypress", key: "Enter" }));

    assert.equal(42, assignedTabId);
    assert.equal(12, assignedGroupId);
    assert.equal("tabs", ui.completerName);
    assert.equal("docs", ui.input.value);
    assert.equal("Work", ui.completions[0].tabGroupTitle);
  });

  should("create a new tab group from the picker query and return to tab search", async () => {
    let createdTabId = null;
    let createdGroupTitle = null;
    let creationCount = 0;
    stub(chrome.runtime, "sendMessage", async (message) => {
      if (message.handler == "filterCompletions") {
        if (message.completerName == "tabs") {
          return [
            {
              description: "tab",
              html: "<span>docs</span>",
              tabId: 42,
              title: "docs",
              url: "https://example.com/docs",
              tabGroupTitle: creationCount > 0 ? "Focus" : null,
              tabGroupColor: creationCount > 0 ? "blue" : null,
            },
          ];
        } else if (message.completerName == "tabGroups") {
          return [
            {
              description: "create tab group",
              html: "<span>create new tab group 'Focus'</span>",
              createTabGroupTitle: "Focus",
              title: "create new tab group 'Focus'",
              url: "create-tab-group:Focus",
            },
          ];
        }
      } else if (message.handler == "createTabGroupForTab") {
        createdTabId = message.tabId;
        createdGroupTitle = message.title;
        creationCount += 1;
      }
    });

    vomnibarPage.reset();
    await vomnibarPage.activate({ completer: "tabs", query: "docs", selectFirst: true });
    ui = vomnibarPage.ui;

    await ui.onKeyEvent(newKeyEvent({ key: "a", ctrlKey: true }));
    ui.input.value = "Focus";
    await ui.update();

    await ui.onKeyEvent(newKeyEvent({ type: "keypress", key: "Enter" }));

    assert.equal(42, createdTabId);
    assert.equal("Focus", createdGroupTitle);
    assert.equal("tabs", ui.completerName);
    assert.equal("docs", ui.input.value);
    assert.equal("Focus", ui.completions[0].tabGroupTitle);
  });

  should("open a URL-like query when enter is pressed", async () => {
    ui.setQuery("www.example.com");
    let handler = null;
    let url = null;
    stub(chrome.runtime, "sendMessage", async (message) => {
      handler = message.handler;
      url = message.url;
    });
    await ui.onKeyEvent(newKeyEvent({ type: "keypress", key: "Enter" }));
    ui.onHidden();
    assert.equal("openUrlInCurrentTab", handler);
    assert.equal("www.example.com", url);
  });

  should("search for a non-URL query when enter is pressed", async () => {
    ui.setQuery("example");
    let handler = null;
    let query = null;
    stub(chrome.runtime, "sendMessage", async (message) => {
      handler = message.handler;
      query = message.query;
    });
    await ui.onKeyEvent(newKeyEvent({ type: "keypress", key: "Enter" }));
    ui.onHidden();
    assert.equal("launchSearchQuery", handler);
    assert.equal("example", query);
  });

  // This test covers #4396.
  should("not treat javascript keywords as user-defined search engines", async () => {
    ui.setQuery("constructor "); // "constructor" is a built-in JS property
    ui.onInput();
    // The query should not be treated as a user search engine.
    assert.equal("constructor ", ui.input.value);
  });
});
