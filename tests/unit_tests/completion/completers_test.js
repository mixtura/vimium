import "../test_helper.js";
import "../../../background_scripts/tab_recency.js";
import "../../../background_scripts/bg_utils.js";
import "../../../background_scripts/completion/search_engines.js";
import "../../../background_scripts/completion/search_wrapper.js";
import * as userSearchEngines from "../../../background_scripts/user_search_engines.js";
import {
  BookmarkCompleter,
  DomainCompleter,
  HistoryCache,
  HistoryCompleter,
  MultiCompleter,
  SearchEngineCompleter,
  Suggestion,
  TabCompleter,
  TabGroupCompleter,
} from "../../../background_scripts/completion/completers.js";
import * as ranking from "../../../background_scripts/completion/ranking.js";
import { RegexpCache } from "../../../background_scripts/completion/ranking.js";
import "../../../lib/url_utils.js";

const hours = (n) => 1000 * 60 * 60 * n;

// A convenience wrapper around completer.filter() so it can be called synchronously in tests.
const filterCompleter = async (completer, queryTerms, request = {}) => {
  return await completer.filter({
    ...request,
    queryTerms,
    query: queryTerms.join(" "),
  });
};

context("bookmark completer", () => {
  const bookmark3 = { title: "bookmark3", url: "bookmark3.com" };
  const bookmark2 = { title: "bookmark2", url: "bookmark2.com" };
  const bookmark1 = { title: "bookmark1", url: "bookmark1.com", children: [bookmark2] };
  let completer;

  setup(() => {
    stub(globalThis.chrome.bookmarks, "getTree", () => [bookmark1]);
    completer = new BookmarkCompleter();
  });

  should("flatten a list of bookmarks with inorder traversal", async () => {
    const result = await completer.traverseBookmarks([bookmark1, bookmark3]);
    assert.equal([bookmark1, bookmark2, bookmark3], result);
  });

  should("return matching bookmarks when searching", async () => {
    completer.refresh();
    const results = await filterCompleter(completer, ["mark2"]);
    assert.equal([bookmark2.url], results.map((suggestion) => suggestion.url));
  });

  should("return *no* matching bookmarks when there is no match", async () => {
    completer.refresh();
    const results = await filterCompleter(completer, ["does-not-match"]);
    assert.equal([], results.map((suggestion) => suggestion.url));
  });

  should("construct bookmark paths correctly", async () => {
    completer.refresh();
    await filterCompleter(completer, ["mark2"]);
    assert.equal("/bookmark1/bookmark2", bookmark2.pathAndTitle);
  });

  should(
    "return matching bookmark *titles* when searching *without* the folder separator character",
    async () => {
      completer.refresh();
      const results = await filterCompleter(completer, ["mark2"]);
      assert.equal(["bookmark2"], results.map((suggestion) => suggestion.title));
    },
  );

  should(
    "return matching bookmark *paths* when searching with the folder separator character",
    async () => {
      completer.refresh();
      const results = await filterCompleter(completer, ["/bookmark1", "mark2"]);
      assert.equal(["/bookmark1/bookmark2"], results.map((suggestion) => suggestion.title));
    },
  );
});

context("HistoryCache", () => {
  const compare = (a, b) => a - b;
  context("binary search", () => {
    should("find elements to the left of the middle", () => {
      assert.equal(0, HistoryCache.binarySearch(3, [3, 5, 8], compare));
    });

    should("find elements to the right of the middle", () => {
      assert.equal(2, HistoryCache.binarySearch(8, [3, 5, 8], compare));
    });

    context("unfound elements", () => {
      should("return 0 if it should be the head of the list", () => {
        assert.equal(0, HistoryCache.binarySearch(1, [3, 5, 8], compare));
      });
      should("return length - 1 if it should be at the end of the list", () => {
        assert.equal(0, HistoryCache.binarySearch(3, [3, 5, 8], compare));
      });
      should(
        "return one passed end of array (so: array.length) if greater than last element in array",
        () => {
          assert.equal(3, HistoryCache.binarySearch(10, [3, 5, 8], compare));
        },
      );
      should("found return the position if it's between two elements", () => {
        assert.equal(1, HistoryCache.binarySearch(4, [3, 5, 8], compare));
        assert.equal(2, HistoryCache.binarySearch(7, [3, 5, 8], compare));
      });
    });
  });

  context("fetchHistory", () => {
    const history1 = { url: "b.com", lastVisitTime: 5 };
    const history2 = { url: "a.com", lastVisitTime: 10 };
    let onVisitedListener, onVisitRemovedListener;

    setup(async () => {
      const history = [history1, history2];
      // const history = [history2, history1];
      onVisitedListener = null;
      onVisitRemovedListener = null;

      stub(globalThis.chrome, "history", {
        search: (_options) => history,
        onVisited: {
          addListener(listener) {
            onVisitedListener = listener;
          },
          removeListener() {},
        },
        onVisitRemoved: {
          addListener(listener) {
            onVisitRemovedListener = listener;
          },
          removeListener() {},
        },
      });

      HistoryCache.reset();
      await HistoryCache.fetchHistory();
    });

    should("store visits sorted by url ascending", () => {
      assert.equal([history2, history1], HistoryCache.history);
    });

    should("add new visits to the history", () => {
      const newSite = { url: "ab.com" };
      onVisitedListener(newSite);
      assert.equal([history2, newSite, history1], HistoryCache.history);
    });

    should("replace new visits in the history", () => {
      assert.equal([history2, history1], HistoryCache.history);
      const newSite = { url: "a.com", lastVisitTime: 15 };
      onVisitedListener(newSite);
      assert.equal([newSite, history1], HistoryCache.history);
    });

    should(
      "(not) remove page from the history, when page is not in history (it should be a no-op)",
      () => {
        assert.equal([history2, history1], HistoryCache.history);
        const toRemove = { urls: ["x.com"], allHistory: false };
        onVisitRemovedListener(toRemove);
        assert.equal([history2, history1], HistoryCache.history);
      },
    );

    should("remove pages from the history", () => {
      assert.equal([history2, history1], HistoryCache.history);
      const toRemove = { urls: ["a.com"], allHistory: false };
      onVisitRemovedListener(toRemove);
      assert.equal([history1], HistoryCache.history);
    });

    should("remove all pages from the history", () => {
      assert.equal([history2, history1], HistoryCache.history);
      const toRemove = { allHistory: true };
      onVisitRemovedListener(toRemove);
      assert.equal([], HistoryCache.history);
    });
  });
});

context("history completer", () => {
  const history1 = { title: "history1", url: "history1.com", lastVisitTime: hours(1) };
  const history2 = { title: "history2", url: "history2.com", lastVisitTime: hours(5) };
  let completer;

  setup(() => {
    completer = new HistoryCompleter();
    stub(globalThis.chrome, "history", {
      search: (_options) => [history1, history2],
      onVisited: { addListener() {}, removeListener() {} },
      onVisitRemoved: { addListener() {}, removeListener() {} },
    });
    HistoryCache.reset();
  });

  should("return matching history entries when searching", async () => {
    const results = await filterCompleter(completer, ["story1"]);
    assert.equal([history1.url], results.map((s) => s.url));
  });

  should("rank recent results higher than nonrecent results", async () => {
    stub(Date, "now", returns(hours(24)));
    const results = await filterCompleter(completer, ["hist"]);
    results.forEach((result) => result.computeRelevancy());
    results.sort((a, b) => b.relevancy - a.relevancy);
    assert.equal([history2.url, history1.url], results.map((result) => result.url));
  });
});

context("domain completer", () => {
  const history1 = { title: "history1", url: "http://history1.com", lastVisitTime: hours(1) };
  const history2 = { title: "history2", url: "http://history2.com", lastVisitTime: hours(1) };
  const undef = { title: "history2", url: "http://undefined.net", lastVisitTime: hours(1) };
  let completer = null;

  setup(() => {
    stub(globalThis.chrome, "history", {
      search: (_options) => [history1, history2, undef],
      onVisited: { addListener() {}, removeListener() {} },
      onVisitRemoved: { addListener() {}, removeListener() {} },
    });
    stub(Date, "now", returns(hours(24)));

    completer = new DomainCompleter();
    HistoryCache.reset();
  });

  should("return only a single matching domain", async () => {
    const results = await filterCompleter(completer, ["story"]);
    assert.equal(["http://history1.com"], results.map((r) => r.url));
  });

  should("pick domains which are more recent", async () => {
    // These domains are the same except for their last visited time.
    let result = await filterCompleter(completer, ["story"]);
    assert.equal("http://history1.com", result[0].url);

    history2.lastVisitTime = hours(3);
    result = await filterCompleter(completer, ["story"]);
    assert.equal("http://history2.com", result[0].url);
  });

  should(
    "returns no results when there's more than one query term, because clearly it's not a domain",
    async () => {
      assert.equal([], await filterCompleter(completer, ["his", "tory"]));
    },
  );

  should("not return any results for empty queries", async () => {
    assert.equal([], await filterCompleter(completer, []));
  });
});

context("domain completer (removing entries)", () => {
  const history1 = { title: "history1", url: "http://history1.com", lastVisitTime: hours(2) };
  const history2 = { title: "history2", url: "http://history2.com", lastVisitTime: hours(1) };
  const history3 = {
    title: "history2something",
    url: "http://history2.com/something",
    lastVisitTime: hours(0),
  };

  let onVisitRemovedListener, completer;

  setup(async () => {
    onVisitRemovedListener = null;
    stub(globalThis.chrome, "history", {
      search: (_options) => [history1, history2, history3],
      onVisited: {
        addListener(_listener) {
        },
      },
      onVisitRemoved: {
        addListener(listener) {
          onVisitRemovedListener = listener;
        },
      },
    });

    stub(Date, "now", returns(hours(24)));

    completer = new DomainCompleter();
    // Force installation of listeners.
    await filterCompleter(completer, ["story"]);
  });

  should("remove 1 entry for domain with reference count of 1", async () => {
    onVisitRemovedListener({ allHistory: false, urls: [history1.url] });
    let result = await filterCompleter(completer, ["story"]);
    assert.equal("http://history2.com", result[0].url);
    result = await filterCompleter(completer, ["story1"]);
    assert.equal(0, result.length);
  });

  should("remove 2 entries for domain with reference count of 2", async () => {
    onVisitRemovedListener({ allHistory: false, urls: [history2.url] });
    let result = await filterCompleter(completer, ["story2"]);
    assert.equal("http://history2.com", result[0].url);
    onVisitRemovedListener({ allHistory: false, urls: [history3.url] });
    result = await filterCompleter(completer, ["story2"]);
    assert.equal(0, result.length);
    result = await filterCompleter(completer, ["story"]);
    assert.equal("http://history1.com", result[0].url);
  });

  should("remove 3 (all) matching domain entries", async () => {
    onVisitRemovedListener({ allHistory: false, urls: [history2.url] });
    onVisitRemovedListener({ allHistory: false, urls: [history1.url] });
    onVisitRemovedListener({ allHistory: false, urls: [history3.url] });
    const result = await filterCompleter(completer, ["story"]);
    assert.equal(0, result.length);
  });

  should("remove 3 (all) matching domain entries, and do it all at once", async () => {
    onVisitRemovedListener({ allHistory: false, urls: [history2.url, history1.url, history3.url] });
    const result = await filterCompleter(completer, ["story"]);
    assert.equal(0, result.length);
  });

  should("remove *all* domain entries", async () => {
    onVisitRemovedListener({ allHistory: true });
    const result = await filterCompleter(completer, ["story"]);
    assert.equal(0, result.length);
  });
});

context("multi completer", () => {
  const tabs = [{ url: "tab1.com", title: "tab1", id: 1 }];
  const tabCompleter = new TabCompleter();
  let multiCompleter;

  setup(() => {
    stub(chrome.tabs, "query", () => tabs);
    multiCompleter = new MultiCompleter([tabCompleter, new DomainCompleter()]);
  });

  should("return an empty list when the query is empty", async () => {
    // Even though a TabCompleter returns results when the query is empty, a MultiCompleter which
    // wraps a TabCompleter should not.
    assert.equal(1, (await filterCompleter(tabCompleter, [])).length);
    assert.equal([], await filterCompleter(multiCompleter, []));
  });
});

context("tab completer", () => {
  const tabs = [
    { url: "tab1.com", title: "tab1", id: 1 },
    { url: "tab2.com", title: "tab2", id: 2 },
  ];
  let completer;

  setup(() => {
    stub(chrome.tabs, "query", () => tabs);
    completer = new TabCompleter();
  });

  should("return tabs by recency when query is empty", async () => {
    const results = await filterCompleter(completer, []);
    assert.equal(["tab1.com", "tab2.com"], results.map((tab) => tab.url));
  });

  should("return matching tabs", async () => {
    const results = await filterCompleter(completer, ["tab2"]);
    assert.equal(["tab2.com"], results.map((tab) => tab.url));
    assert.equal([2], results.map((tab) => tab.tabId));
  });

  should("attach tab group information to grouped tabs", async () => {
    stub(chrome.tabs, "query", () => [
      { url: "tab1.com", title: "tab1", id: 1, groupId: 12 },
    ]);
    stub(chrome.tabGroups, "query", () => [
      { id: 12, color: "blue", title: "Work" },
    ]);

    const results = await filterCompleter(completer, ["tab1"]);

    assert.equal("Work", results[0].tabGroupTitle);
    assert.equal("blue", results[0].tabGroupColor);
  });

  should("filter tabs by tab-group name with group:query syntax", async () => {
    stub(chrome.tabs, "query", () => [
      { url: "work-tab.com", title: "docs", id: 1, groupId: 12 },
      { url: "play-tab.com", title: "docs", id: 2, groupId: 13 },
    ]);
    stub(chrome.tabGroups, "query", () => [
      { id: 12, color: "blue", title: "Work" },
      { id: 13, color: "green", title: "Play" },
    ]);

    const results = await filterCompleter(completer, ["work:docs"], { query: "work:docs" });

    assert.equal(["work-tab.com"], results.map((tab) => tab.url));
  });

  should("filter tabs by tab-group name when only the group filter is provided", async () => {
    stub(chrome.tabs, "query", () => [
      { url: "work-tab.com", title: "docs", id: 1, groupId: 12 },
      { url: "play-tab.com", title: "chat", id: 2, groupId: 13 },
      { url: "ungrouped-tab.com", title: "mail", id: 3, groupId: -1 },
    ]);
    stub(chrome.tabGroups, "query", () => [
      { id: 12, color: "blue", title: "Work" },
      { id: 13, color: "green", title: "Play" },
    ]);

    const results = await filterCompleter(completer, ["work:"], { query: "work:" });

    assert.equal(["work-tab.com"], results.map((tab) => tab.url));
  });

  should("filter to ungrouped tabs with :query syntax", async () => {
    stub(chrome.tabs, "query", () => [
      { url: "grouped-tab.com", title: "docs", id: 1, groupId: 12 },
      { url: "ungrouped-tab.com", title: "docs", id: 2, groupId: -1 },
    ]);
    stub(chrome.tabGroups, "query", () => [
      { id: 12, color: "blue", title: "Work" },
    ]);

    const results = await filterCompleter(completer, [":docs"], { query: ":docs" });

    assert.equal(["ungrouped-tab.com"], results.map((tab) => tab.url));
  });

  should("filter to all ungrouped tabs with bare : syntax", async () => {
    stub(chrome.tabs, "query", () => [
      { url: "grouped-tab.com", title: "docs", id: 1, groupId: 12 },
      { url: "ungrouped-tab.com", title: "mail", id: 2, groupId: -1 },
    ]);
    stub(chrome.tabGroups, "query", () => [
      { id: 12, color: "blue", title: "Work" },
    ]);

    const results = await filterCompleter(completer, [":"], { query: ":" });

    assert.equal(["ungrouped-tab.com"], results.map((tab) => tab.url));
  });
});

context("tab vomnibar result limits", () => {
  let completer;

  setup(() => {
    const tabs = Array.from({ length: 12 }, (_, i) => ({
      url: `tab${i + 1}.com`,
      title: `tab${i + 1}`,
      id: i + 1,
    }));
    stub(chrome.tabs, "query", () => tabs);
    completer = new MultiCompleter([new TabCompleter()]);
  });

  should("default to 10 results", async () => {
    const results = await filterCompleter(completer, ["tab"]);
    assert.equal(10, results.length);
  });

  should("honor an overridden maxResults for tab selection", async () => {
    const results = await filterCompleter(completer, ["tab"], { maxResults: 12 });
    assert.equal(12, results.length);
  });
});

context("tab group completer", () => {
  let completer;

  setup(() => {
    completer = new TabGroupCompleter();
    stub(chrome.tabGroups, "query", () => [
      { id: 12, color: "blue", title: "Work" },
      { id: 13, color: "green", title: "Play" },
    ]);
  });

  should("return all tab groups when the query is empty", async () => {
    const results = await completer.filter({ queryTerms: [] });

    assert.equal([12, 13], results.map((group) => group.tabGroupId));
  });

  should("filter tab groups by title", async () => {
    const results = await completer.filter({ queryTerms: ["work"] });

    assert.equal([12], results.map((group) => group.tabGroupId));
  });

  should("append a create-new-group suggestion when the query is non-empty", async () => {
    const results = await completer.filter({ queryTerms: ["focus"], query: "focus" });

    assert.equal("create tab group", results.at(-1).description);
    assert.equal("focus", results.at(-1).createTabGroupTitle);
  });
});

context("SearchEngineCompleter", () => {
  const googleSearchUrl = "http://www.google.com/search?q=";
  let completer;

  const createResponse = (responseText) => {
    return { text: () => responseText };
  };

  setup(() => {
    completer = new SearchEngineCompleter();
    const searchEngineConfig = `g: ${googleSearchUrl}%s`;
    userSearchEngines.set(searchEngineConfig);
  });

  should("complete search results using the given completer", async () => {
    const googleResults = ["blue", ["blue1", "blue2"]];
    stub(globalThis, "fetch", () => createResponse(JSON.stringify(googleResults)));
    const results = await filterCompleter(completer, ["g", "blue"]);
    assert.equal(
      [googleSearchUrl + "blue", googleSearchUrl + "blue1", googleSearchUrl + "blue2"],
      results.map((suggestion) => suggestion.url),
    );
  });
});

context("suggestions", () => {
  setup(() => {
    stub(chrome.runtime, "getURL", returns("https://test/"));
  });

  should("escape html in page titles", () => {
    const suggestion = new Suggestion({
      queryTerms: ["queryterm"],
      description: "tab",
      url: "url",
      title: "title <span>",
      relevancyFunction: returns(1),
    });
    assert.isTrue(suggestion.generateHtml({}).indexOf("title &lt;span&gt;") >= 0);
  });

  should("highlight query words", () => {
    const suggestion = new Suggestion({
      queryTerms: ["ninj", "words"],
      description: "tab",
      url: "url",
      title: "ninjawords",
      relevancyFunction: returns(1),
    });
    const expected = "<span class='match'>ninj</span>a<span class='match'>words</span>";
    assert.isTrue(suggestion.generateHtml({}).indexOf(expected) >= 0);
  });

  should("highlight query words correctly when whey they overlap", () => {
    const suggestion = new Suggestion({
      queryTerms: ["ninj", "jaword"],
      description: "tab",
      url: "url",
      title: "ninjawords",
      relevancyFunction: returns(1),
    });
    const expected = "<span class='match'>ninjaword</span>s";
    assert.isTrue(suggestion.generateHtml({}).indexOf(expected) >= 0);
  });

  should("render a colored tab group badge", () => {
    const suggestion = new Suggestion({
      queryTerms: [],
      description: "tab",
      url: "url",
      title: "title",
      tabGroupTitle: "Work",
      tabGroupColor: "blue",
      relevancyFunction: returns(1),
    });

    const html = suggestion.generateHtml({});
    assert.isTrue(html.indexOf("tab-group-badge") >= 0);
    assert.isTrue(html.indexOf("tab-group-blue") >= 0);
    assert.isTrue(html.indexOf(">Work<") >= 0);
    assert.isTrue(html.indexOf("title</span><span class=\"tab-group-badge") >= 0);
  });

  should("shorten urls", () => {
    const suggestion = new Suggestion({
      queryTerms: ["queryterm"],
      description: "history",
      url: "http://ninjawords.com",
      title: "ninjawords",
      relevancyFunction: returns(1),
    });
    assert.equal(-1, suggestion.generateHtml({}).indexOf("http://ninjawords.com"));
  });
});

// TODO: (smblott)
// Word relevancy should take into account the number of matches (it doesn't currently). should
// "score higher for multiple matches (in a URL)", ->
//   lowScore  = ranking.wordRelevancy(["stack"], "http://stackoverflow.com/Xxxxxx", "a-title")
//   highScore = ranking.wordRelevancy(["stack"], "http://stackoverflow.com/Xstack", "a-title")
//   assert.isTrue highScore > lowScore

// should "score higher for multiple matches (in a title)", ->
//   lowScore  = ranking.wordRelevancy(["bbc"], "http://stackoverflow.com/same", "BBC Radio 4 (XBCr4)")
//   highScore = ranking.wordRelevancy(["bbc"], "http://stackoverflow.com/same", "BBC Radio 4 (BBCr4)")
//   assert.isTrue highScore > lowScore

context("Suggestion.pushMatchingRanges", () => {
  should("extract ranges matching term (simple case, two matches)", () => {
    const ranges = [];
    const [one, two, three] = ["one", "two", "three"];
    const suggestion = new Suggestion([], "", "", "", returns(1));
    suggestion.pushMatchingRanges(`${one}${two}${three}${two}${one}`, two, ranges);
    assert.equal(
      2,
      Utils.zip([ranges, [[3, 6], [11, 14]]]).filter((pair) =>
        (pair[0][0] === pair[1][0]) && (pair[0][1] === pair[1][1])
      ).length,
    );
  });

  should("extract ranges matching term (two matches, one at start of string)", () => {
    const ranges = [];
    const [one, two, three] = ["one", "two", "three"];
    const suggestion = new Suggestion([], "", "", "", returns(1));
    suggestion.pushMatchingRanges(`${two}${three}${two}${one}`, two, ranges);
    assert.equal(
      2,
      Utils.zip([ranges, [[0, 3], [8, 11]]]).filter((pair) =>
        (pair[0][0] === pair[1][0]) && (pair[0][1] === pair[1][1])
      ).length,
    );
  });

  should("extract ranges matching term (two matches, one at end of string)", () => {
    const ranges = [];
    const [one, two, three] = ["one", "two", "three"];
    const suggestion = new Suggestion([], "", "", "", returns(1));
    suggestion.pushMatchingRanges(`${one}${two}${three}${two}`, two, ranges);
    assert.equal(
      2,
      Utils.zip([ranges, [[3, 6], [11, 14]]]).filter((pair) =>
        (pair[0][0] === pair[1][0]) && (pair[0][1] === pair[1][1])
      ).length,
    );
  });

  should("extract ranges matching term (no matches)", () => {
    const ranges = [];
    const [one, two, three] = ["one", "two", "three"];
    const suggestion = new Suggestion([], "", "", "", returns(1));
    suggestion.pushMatchingRanges(`${one}${two}${three}${two}${one}`, "does-not-match", ranges);
    assert.equal(0, ranges.length);
  });
});
