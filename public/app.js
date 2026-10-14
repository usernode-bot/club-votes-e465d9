/* Club Votes: the two drawn screens, wired to the API.
 *
 * Hash routes: #/ the decision list (Open and Closed tabs), #/d/:id one
 * decision, #/new post a decision. The list screen's shell is static in
 * index.html; only its cards and counts are rendered here. The detail and
 * new screens render into #view, copied from the spec's drawn screen 2.
 */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var demoQs = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';

  // The bridge reports the platform's time (a staging preview may be shown
  // as of a chosen moment); fall back to the clock only outside the bridge.
  function nowMs() {
    try {
      if (window.usernode && typeof window.usernode.now === 'function') {
        var n = window.usernode.now();
        return new Date(n).getTime();
      }
    } catch (e) {}
    return Date.now();
  }

  function getToken() {
    var t = new URLSearchParams(location.search).get('token');
    if (t) return t;
    try {
      if (window.usernode && window.usernode.token) return window.usernode.token;
    } catch (e) {}
    return '';
  }

  function api(method, path, body) {
    var opts = {
      method: method,
      headers: {
        'x-usernode-token': getToken(),
        'x-usernode-now': new Date(nowMs()).toISOString(),
      },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path + demoQs, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Something went wrong.');
          err.status = res.status;
          err.code = data.error;
          throw err;
        }
        return data;
      });
    });
  }

  function writeError(err) {
    if (err && err.code === 'account_required') {
      return 'Make a Homeroom account to post, vote and comment.';
    }
    return (err && err.message) || 'Something went wrong.';
  }

  function relTime(iso) {
    var s = Math.max(0, Math.round((nowMs() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.round(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return d + ' days ago';
    var w = Math.round(d / 7);
    return w + (w === 1 ? ' week ago' : ' weeks ago');
  }

  var RESULT_TEXT = { passed: 'Passed', not_passed: 'Did not pass', tied: 'Tied' };
  var RESULT_SENTENCE = {
    passed: 'This vote is closed. It passed.',
    not_passed: 'This vote is closed. It did not pass.',
    tied: 'This vote is closed. It was a tie.',
  };

  var CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg>';
  var CHAT_SVG = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>';
  var BACK_SVG = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';

  // ── Shared pieces ──────────────────────────────────────────────────────────

  // The live tally bar, a show of hands: one segment per answer, then the
  // members still to vote. Segments with nothing in them are not drawn; an
  // all-empty bar is one empty segment so the bar never vanishes.
  function tallyHtml(d) {
    var c = d.counts;
    var out = '';
    if (c.yes) out += '<span class="y" style="flex:' + c.yes + '"></span>';
    if (c.no) out += '<span class="n" style="flex:' + c.no + '"></span>';
    if (c.maybe) out += '<span class="m" style="flex:' + c.maybe + '"></span>';
    var voted = c.yes + c.no + c.maybe;
    var notVoted = d.memberCount == null ? 0 : Math.max(0, d.memberCount - voted);
    if (notVoted) out += '<span class="e" style="flex:' + notVoted + '"></span>';
    else if (!out) out += '<span class="e" style="flex:1"></span>';
    return '<div class="tally">' + out + '</div>';
  }

  function countsHtml(d) {
    var c = d.counts;
    var notVoted = d.memberCount == null
      ? ''
      : '<span class="muted">' + Math.max(0, d.memberCount - c.yes - c.no - c.maybe) + ' not voted</span>';
    return '<div class="counts">'
      + '<span><i class="y"></i><b>' + c.yes + '</b> yes</span>'
      + '<span><i class="n"></i><b>' + c.no + '</b> no</span>'
      + '<span><i class="m"></i><b>' + c.maybe + '</b> maybe</span>'
      + notVoted + '</div>';
  }

  function byline(d) {
    return (d.mine ? 'You' : esc(d.creator.username)) + ', ' + relTime(d.createdAt);
  }

  function badgeHtml(d) {
    return '<span class="badge"><i></i>' + (d.closedAt ? RESULT_TEXT[d.result] : 'Open') + '</span>';
  }

  function footHtml(d) {
    var mine = d.myVote
      ? '<span class="small mine">' + CHECK_SVG + 'You voted ' + d.myVote + '</span>'
      : '<span class="small muted">You have not voted</span>';
    var comments = d.commentCount
      ? '<span class="small muted">' + CHAT_SVG + d.commentCount + (d.commentCount === 1 ? ' comment' : ' comments') + '</span>'
      : '<span class="small muted">' + CHAT_SVG + 'No comments yet</span>';
    return '<div class="foot">' + mine + comments + '</div>';
  }

  function cardHtml(d) {
    return '<div class="card tappable" data-open="' + d.id + '" tabindex="0" role="link">'
      + '<div class="meta">' + badgeHtml(d) + '<span class="small muted">' + byline(d) + '</span></div>'
      + '<p class="q">' + esc(d.question) + '</p>'
      + tallyHtml(d) + countsHtml(d) + footHtml(d) + '</div>';
  }

  function skeletonCards(n) {
    var out = '';
    for (var i = 0; i < n; i++) {
      out += '<div class="card"><div class="meta"><span class="skel" style="width:58px"></span>'
        + '<span class="skel" style="width:110px"></span></div>'
        + '<p class="skel" style="height:20px;width:' + (65 + (i % 3) * 10) + '%;margin:6px 0 12px"></p>'
        + '<div class="tally"><span class="e" style="flex:1"></span></div>'
        + '<div class="counts"><span class="skel" style="width:56px"></span>'
        + '<span class="skel" style="width:48px"></span><span class="skel" style="width:70px"></span></div>'
        + '<div class="foot"><span class="skel" style="width:120px"></span>'
        + '<span class="skel" style="width:92px"></span></div></div>';
    }
    return out;
  }

  function stateHtml(title, note, button) {
    return '<div class="state"><p class="q">' + title + '</p><p class="muted">' + note + '</p>'
      + (button || '') + '</div>';
  }

  function flash(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
  }

  // ── List screen (#/) ───────────────────────────────────────────────────────
  // The shell is static in index.html; the cards, counts and section label
  // are rendered here.

  var listData = null;   // { open, closed, memberCount } from the API
  var listTab = 'open';
  var listBusy = false;

  function renderList() {
    $('#screen-list').hidden = false;
    $('#view').hidden = true;
    if (!listData && !listBusy) loadList();
    paintList();
  }

  function loadList() {
    listBusy = true;
    paintList();
    api('GET', '/api/decisions')
      .then(function (data) { listData = data; })
      .catch(function () { listData = { error: true }; })
      .then(function () { listBusy = false; paintList(); });
  }

  function paintList() {
    var root = $('[data-decisions]');
    var data = listData;
    var rows = data && !data.error ? (listTab === 'open' ? data.open : data.closed) : null;

    // Tab counts and the section label above the cards.
    $('[data-count-open]').textContent = data && !data.error ? data.open.length : '';
    $('[data-count-closed]').textContent = data && !data.error ? data.closed.length : '';

    // The staging demo replaces the app's name in the line above the title.
    var appLine = $('[data-app-line]');
    if (appLine) appLine.textContent = demoQs ? 'Staging demo' : 'Club Votes';

    // "Waiting on votes" belongs above cards; not over an empty or failed
    // list. And the error state's Retry stays the screen's one filled
    // button, so the header's New decision steps down to secondary.
    var empty = data && !data.error && data[listTab].length === 0;
    var label = $('.section-label[data-section-label]');
    label.textContent = listTab === 'open' ? 'Waiting on votes' : 'Closed votes';
    label.hidden = !!data && (data.error || empty);
    var headerBtn = $('[data-new-action]');
    if (headerBtn) headerBtn.className = data && data.error ? 'btn-secondary' : 'btn-primary';

    var flashEl = $('[data-flash]');
    if (!data) {
      root.innerHTML = skeletonCards(3);
      return;
    }
    if (data.error) {
      root.innerHTML = stateHtml(
        'Could not load the club&rsquo;s decisions.',
        'Nothing you posted is lost. The Open and Closed tabs will be here again when the app can reach the club.',
        '<button class="btn-primary" data-retry>Retry</button>');
      return;
    }
    if (!rows.length) {
      root.innerHTML = listTab === 'open'
        ? stateHtml('No open decisions yet',
            'Post the first thing the club needs to decide, and everyone can vote yes, no or maybe.',
            '<button class="btn-primary" data-new>New decision</button>')
        : stateHtml('Nothing closed yet',
            'When the club has decided, a vote moves here with its result.');
      flash(flashEl, '');
      return;
    }
    flash(flashEl, '');
    root.innerHTML = rows.map(cardHtml).join('');
  }

  // ── Detail screen (#/d/:id), copied from the spec's drawn screen 2 ─────────

  var detailId = null;

  function renderDetail(root, id) {
    $('#screen-list').hidden = true;
    $('#view').hidden = false;
    detailId = id;
    root.innerHTML = '<div data-spec-screen="1"><div class="cv">'
      + '<div class="bar"><button class="link" data-back>' + BACK_SVG + 'Decisions</button></div>'
      + '<div class="card">' + skeletonCards(1) + '</div></div></div>';
    api('GET', '/api/decisions/' + id)
      .then(function (data) { if (detailId === id) paintDetail(root, data, ''); })
      .catch(function (err) {
        if (detailId !== id) return;
        root.innerHTML = '<div data-spec-screen="1"><div class="cv">'
          + '<div class="bar"><button class="link" data-back>' + BACK_SVG + 'Decisions</button></div>'
          + stateHtml('Could not load this decision.',
              'The Open and Closed tabs still work. Nothing you posted is lost.',
              '<button class="btn-primary" data-retry-detail="' + id + '">Retry</button>')
          + '</div></div>';
      });
  }

  function paintDetail(root, d, flashMsg) {
    var c = d.counts;
    var open = !d.closedAt;
    var commentRows = d.comments.map(function (cm) {
      var who = '<div class="who"><b>' + (cm.mine ? 'You' : esc(cm.author.username)) + '</b>'
        + (cm.authorVote ? '<span class="vote">voted ' + cm.authorVote + '</span>' : '')
        + '<span class="small muted">' + relTime(cm.createdAt) + '</span></div>';
      var end = cm.mine
        ? '<button class="link quiet" data-del-comment="' + cm.id + '">Delete</button>'
        : '<button class="link quiet" data-report-comment="' + cm.id + '">Report</button>';
      return '<li class="list-row">' + who + '<p>' + esc(cm.body) + '</p>'
        + '<div class="row-end">' + end + '</div></li>';
    }).join('');

    var voteBlock = '';
    if (open) {
      var seg = [['yes', 'y', 'Yes'], ['no', 'n', 'No'], ['maybe', 'm', 'Maybe']].map(function (p) {
        var cls = 'seg-vote' + (d.myVote === p[0] ? ' on ' + p[1] : '');
        return '<button class="' + cls + '" data-vote="' + p[0] + '"><i class="' + p[1] + '"></i>' + p[2] + '</button>';
      }).join('');
      var closeBlock = d.mine
        ? '<div class="close"><p class="small muted">You posted this, so you close it when the club has decided.</p>'
          + '<button class="btn-secondary" data-close>Close vote</button></div>'
        : '';
      voteBlock = '<p class="small muted" style="margin-bottom:8px">Your vote, change it any time while open</p>'
        + '<div class="seg">' + seg + '</div>' + closeBlock;
    } else {
      voteBlock = '<p class="small muted" style="margin-bottom:8px">' + esc(RESULT_SENTENCE[d.result] || 'This vote is closed.') + '</p>';
    }

    var commentSection = d.comments.length
      ? '<p class="section-label">' + d.comments.length + (d.comments.length === 1 ? ' comment' : ' comments') + '</p>'
        + '<ul class="list">' + commentRows + '</ul>'
      : '<p class="section-label">No comments yet</p>';

    root.innerHTML = '<div data-spec-screen="1"><div class="cv">'
      + '<div class="bar"><button class="link" data-back>' + BACK_SVG + 'Decisions</button>'
      + (d.mine ? '<button class="link quiet" data-del-decision="' + d.id + '">' + TRASH_SVG + 'Delete</button>' : '')
      + '</div>'
      + '<div class="meta">' + badgeHtml(d) + '<span class="small muted">' + byline(d) + '</span></div>'
      + '<h1 class="title">' + esc(d.question) + '</h1>'
      + (d.details ? '<p class="note">' + esc(d.details) + '</p>' : '')
      + '<div class="card">' + tallyHtml(d) + countsHtml(d) + voteBlock + '</div>'
      + commentSection
      + '<label for="c">Add a comment</label>'
      + '<textarea id="c" class="field" placeholder="e.g. I can bring the boards"></textarea>'
      + '<div class="send"><button class="btn-primary" data-comment="' + d.id + '">Post comment</button></div>'
      + '<p class="small" data-detail-flash' + (flashMsg ? '' : ' hidden') + ' style="color:rgb(var(--danger));margin-top:8px">' + esc(flashMsg) + '</p>'
      + '</div></div>';
  }

  function reloadDetail(root, id, msg) {
    api('GET', '/api/decisions/' + id)
      .then(function (data) { if (detailId === id) paintDetail(root, data, msg || ''); })
      .catch(function (err) {
        if (detailId === id) flash($('[data-detail-flash]', root), writeError(err));
      });
  }

  // ── New decision screen (#/new), built from the design kit ────────────────

  function renderNew(root) {
    $('#screen-list').hidden = true;
    $('#view').hidden = false;
    root.innerHTML = '<div data-spec-screen="1"><div class="cv">'
      + '<div class="bar"><button class="link" data-back>' + BACK_SVG + 'Decisions</button></div>'
      + '<h1 class="title" style="margin:0 4px 4px">New decision</h1>'
      + '<p class="note" style="margin:0 4px 24px">Ask the club something it needs to decide. Everyone votes yes, no or maybe, and you close the vote when it has.</p>'
      + '<label for="nq" style="margin:0 4px 6px">Question</label>'
      + '<input id="nq" class="field short" placeholder="e.g. Move the club night to Fridays?">'
      + '<label for="nd" style="margin:16px 4px 6px">Details (optional)</label>'
      + '<textarea id="nd" class="field" placeholder="e.g. Anything that helps the club vote, such as costs or times"></textarea>'
      + '<div class="send"><button class="btn-primary" data-post>Post decision</button></div>'
      + '<p class="small" data-new-flash hidden style="color:rgb(var(--danger));margin-top:8px"></p>'
      + '</div></div>';
    $('#nq', root).focus();
  }

  function postNew(root) {
    var question = $('#nq', root).value.trim();
    var details = $('#nd', root).value.trim();
    if (!question) { flash($('[data-new-flash]', root), 'Write a question first.'); return; }
    api('POST', '/api/decisions', { question: question, details: details })
      .then(function (data) {
        listData = null;
        location.hash = '#/d/' + data.id;
      })
      .catch(function (err) { flash($('[data-new-flash]', root), writeError(err)); });
  }

  // ── Router and events ──────────────────────────────────────────────────────

  function route() {
    var hash = location.hash || '#/';
    var root = $('#view');
    var m = hash.match(/^#\/d\/(\d+)$/);
    if (m) { renderDetail(root, Number(m[1])); return; }
    detailId = null;
    if (hash === '#/new') { renderNew(root); return; }
    renderList();
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-open],[data-retry],[data-new],[data-new-action],[data-back],[data-vote],[data-close],[data-comment],[data-del-decision],[data-del-comment],[data-report-comment],[data-post],[data-retry-detail]') : null;
    if (!t) return;
    var root = $('#view');

    if (t.hasAttribute('data-open')) {
      location.hash = '#/d/' + t.getAttribute('data-open');
    } else if (t.hasAttribute('data-retry')) {
      listData = null; loadList();
    } else if (t.hasAttribute('data-new') || t.hasAttribute('data-new-action')) {
      location.hash = '#/new';
    } else if (t.hasAttribute('data-back')) {
      listData = null; location.hash = '#/';
    } else if (t.hasAttribute('data-post')) {
      postNew(root);
    } else if (t.hasAttribute('data-retry-detail')) {
      renderDetail(root, Number(t.getAttribute('data-retry-detail')));
    } else if (t.hasAttribute('data-vote')) {
      var id = detailId;
      api('PUT', '/api/decisions/' + id + '/vote', { choice: t.getAttribute('data-vote') })
        .then(function () { listData = null; reloadDetail(root, id); })
        .catch(function (err) {
          if (err.status === 409) { listData = null; reloadDetail(root, id); return; }
          flash($('[data-detail-flash]', root), writeError(err));
        });
    } else if (t.hasAttribute('data-close')) {
      var id2 = detailId;
      if (!window.confirm('Close this vote? The club will see the result, and no one can vote after.')) return;
      api('POST', '/api/decisions/' + id2 + '/close')
        .then(function () { listData = null; reloadDetail(root, id2); })
        .catch(function (err) { flash($('[data-detail-flash]', root), writeError(err)); });
    } else if (t.hasAttribute('data-comment')) {
      var id3 = detailId;
      var box = $('#c', root);
      var body = box.value.trim();
      if (!body) { flash($('[data-detail-flash]', root), 'Write a comment first.'); return; }
      t.disabled = true;
      api('POST', '/api/decisions/' + id3 + '/comments', { body: body })
        .then(function () { reloadDetail(root, id3); })
        .catch(function (err) { t.disabled = false; flash($('[data-detail-flash]', root), writeError(err)); });
    } else if (t.hasAttribute('data-del-decision')) {
      var id4 = detailId;
      if (!window.confirm('Delete this decision, its votes and its comments? This cannot be undone.')) return;
      api('DELETE', '/api/decisions/' + id4)
        .then(function () { listData = null; location.hash = '#/'; })
        .catch(function (err) { flash($('[data-detail-flash]', root), writeError(err)); });
    } else if (t.hasAttribute('data-del-comment')) {
      if (!window.confirm('Delete your comment?')) return;
      api('DELETE', '/api/comments/' + t.getAttribute('data-del-comment'))
        .then(function () { reloadDetail(root, detailId); })
        .catch(function (err) { flash($('[data-detail-flash]', root), writeError(err)); });
    } else if (t.hasAttribute('data-report-comment')) {
      if (!window.confirm('Report this comment to the person running the app?')) return;
      var rid = t.getAttribute('data-report-comment');
      api('POST', '/api/reports', { kind: 'comment', id: Number(rid) })
        .then(function () { t.textContent = 'Reported'; t.disabled = true; })
        .catch(function (err) { flash($('[data-detail-flash]', root), writeError(err)); });
    }
  });

  // Opening a decision from the keyboard, as well as the tap.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var t = ev.target.closest ? ev.target.closest('[data-open]') : null;
    if (!t || t.tagName !== 'DIV') return;
    ev.preventDefault();
    location.hash = '#/d/' + t.getAttribute('data-open');
  });

  // The comment box posts on Ctrl/Cmd+Enter too.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' || !(ev.ctrlKey || ev.metaKey)) return;
    if (ev.target && ev.target.id === 'c') {
      var btn = $('[data-comment]');
      if (btn) btn.click();
    }
  });

  // The question box posts on Enter.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    if (ev.target && ev.target.id === 'nq') {
      var btn = $('[data-post]');
      if (btn) btn.click();
    }
  });

  // The tabs switch without a refetch; the section label and the demo line
  // live in the static shell.
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('.tab') : null;
    if (!t) return;
    listTab = t.hasAttribute('data-tab-closed') ? 'closed' : 'open';
    document.querySelectorAll('.tab').forEach(function (el) {
      el.classList.toggle('on', el === t);
    });
    paintList();
  });

  window.addEventListener('hashchange', route);
  route();
})();
