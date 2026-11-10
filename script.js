function init() {
  const gatePanel = document.querySelector("#gatePanel");
  const copyPanel = document.querySelector("#copyPanel");
  const copyHeading = document.querySelector("#copyHeading");
  const copyText = document.querySelector("#copyText");
  const copyButton = document.querySelector("#copyButton");
  const imagePreview = document.querySelector("#imagePreview");
  const postImage = document.querySelector("#postImage");
  const notice = document.querySelector("#notice");
  const toast = document.querySelector("#toast");

  if (!gatePanel || !copyPanel || !copyText || !copyButton || !notice || !toast) {
    console.error("Missing required UI elements.");
    return;
  }

  const sectionId = new URLSearchParams(location.search).get("s") || "";
  let toastTimer;
  let activeReservation = null;
  let localCopied = false;
  let copyCommitted = false;
  let commitStarted = false;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1400);
  }

  function afterPaint(callback) {
    requestAnimationFrame(() => setTimeout(callback, 0));
  }

  let decorationsLoaded = false;
  function loadDecorations() {
    if (decorationsLoaded) return;
    decorationsLoaded = true;
    document.querySelectorAll(".brand source[data-srcset]").forEach((source) => {
      source.srcset = source.dataset.srcset;
    });
    document.querySelectorAll(".brand img[data-src]").forEach((image) => {
      image.src = image.dataset.src;
    });
    document.body.classList.add("bg-ready");
  }

  function hideCopy() {
    copyPanel.hidden = true;
    copyText.value = "";
    imagePreview.hidden = true;
    postImage.removeAttribute("src");
  }

  function showGate() {
    hideCopy();
    notice.hidden = true;
    gatePanel.hidden = false;
    afterPaint(loadDecorations);
  }

  function showProblem(message) {
    hideCopy();
    gatePanel.hidden = true;
    notice.hidden = false;
    notice.textContent = message || "这个入口无效";
    activeReservation = null;
    afterPaint(loadDecorations);
  }

  function showCopy(data) {
    activeReservation = { textId: data.textId, reservationToken: data.reservationToken };
    localCopied = false;
    copyCommitted = false;
    commitStarted = false;
    gatePanel.hidden = true;
    notice.hidden = true;
    copyHeading.textContent = data.sectionName || "笔记文案";
    copyText.value = data.text || "";
    copyPanel.hidden = false;
    copyButton.disabled = false;
    imagePreview.hidden = true;
    postImage.removeAttribute("src");
    afterPaint(() => {
      if (data.image) {
        postImage.src = data.image;
        imagePreview.hidden = false;
      }
      loadDecorations();
    });
  }

  async function releaseActive(keepalive = false) {
    if (!activeReservation || copyCommitted || commitStarted) return;
    const payload = activeReservation;
    activeReservation = null;
    try {
      await fetch("/api/claim/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive,
      });
    } catch (error) {
      console.error(error);
    }
  }

  async function loadEntry() {
    if (!sectionId) {
      showGate();
      return;
    }
    if (!/^[a-f0-9]{8,32}$/i.test(sectionId)) {
      showProblem("这个入口无效");
      return;
    }

    const early = window.__sectionPreview;
    window.__sectionPreview = null;
    const data = early
      ? await early
      : await fetch(`/api/sections/${encodeURIComponent(sectionId)}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then((response) => response.json());
    if (!data.ok) {
      showProblem(data.message || "这个入口无效");
      return;
    }
    showCopy(data);
  }

  async function writeClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      console.error(error);
    }
    try {
      copyText.focus();
      copyText.select();
      return document.execCommand("copy");
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  async function commitCopy() {
    if (copyCommitted || commitStarted || !activeReservation) return false;
    commitStarted = true;
    try {
      const response = await fetch("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify(activeReservation),
      });
      const data = await response.json();
      if (!data.ok) {
        commitStarted = false;
        if (String(data.message || "").includes("失效")) {
          activeReservation = null;
          localCopied = false;
          showProblem(data.message);
          showToast(data.message);
          return false;
        }
        showToast("标记失败，请重试");
        return false;
      }
      copyCommitted = true;
      activeReservation = null;
      showToast("复制成功");
      return true;
    } catch (error) {
      commitStarted = false;
      showToast("网络异常，请重试");
      console.error(error);
      return false;
    }
  }

  async function copyFromPanel() {
    if (!copyText.value || copyPanel.hidden) return;
    if (copyCommitted) {
      showToast("已经复制");
      return;
    }
    if (!localCopied) {
      const copied = await writeClipboard(copyText.value);
      if (!copied) {
        showToast("复制失败，请手动复制");
        return;
      }
      localCopied = true;
    }
    await commitCopy();
  }

  copyButton.addEventListener("click", () => {
    copyFromPanel();
  });
  copyText.addEventListener("copy", () => {
    if (!copyText.value || copyPanel.hidden) return;
    localCopied = true;
    commitCopy();
  });
  window.addEventListener("pagehide", () => {
    if (!activeReservation || copyCommitted || commitStarted) return;
    fetch("/api/claim/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activeReservation),
      keepalive: true,
    }).catch(() => {});
  });

  // A stalled copy request should not leave the page without its decorations forever.
  setTimeout(loadDecorations, 4000);
  loadEntry().catch((error) => {
    showProblem("素材加载失败，请稍后重试。");
    console.error(error);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
