function init() {
  const gatePanel = document.querySelector("#gatePanel");
  const copyPanel = document.querySelector("#copyPanel");
  const copyHeading = document.querySelector("#copyHeading");
  const copyText = document.querySelector("#copyText");
  const copyButton = document.querySelector("#copyButton");
  const imagePreview = document.querySelector("#imagePreview");
  const postImage = document.querySelector("#postImage");
  const notice = document.querySelector("#notice");
  const statusText = document.querySelector("#status");
  const toast = document.querySelector("#toast");

  if (!gatePanel || !copyPanel || !copyText || !copyButton || !notice || !statusText || !toast) {
    console.error("Missing required UI elements.");
    return;
  }

  const sectionId = new URLSearchParams(location.search).get("s") || "";
  let toastTimer;
  let activeReservation = null;
  let localCopied = false;
  let copyCommitted = false;
  let commitStarted = false;

  function setStatus(message) {
    statusText.textContent = message;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1400);
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
    setStatus("");
  }

  function showProblem(message) {
    hideCopy();
    gatePanel.hidden = true;
    notice.hidden = false;
    notice.textContent = message || "这个入口无效";
    setStatus(message || "这个入口无效");
    activeReservation = null;
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
    if (data.image) {
      imagePreview.hidden = false;
      postImage.src = data.image;
    } else {
      imagePreview.hidden = true;
      postImage.removeAttribute("src");
    }
    setStatus("文案已就绪。复制成功后才会标记已用。");
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

    setStatus("正在读取文案...");
    const response = await fetch(`/api/sections/${encodeURIComponent(sectionId)}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
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
        setStatus(data.message || "复制已完成，但标记失败，请再点一次复制。");
        showToast("标记失败，请重试");
        return false;
      }
      copyCommitted = true;
      activeReservation = null;
      setStatus("文案已复制，可以直接粘贴到小红书。");
      showToast("复制成功");
      return true;
    } catch (error) {
      commitStarted = false;
      setStatus("复制已完成，但标记失败，请再点一次复制。");
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
        setStatus("自动复制失败，请在文案框中长按或选择后复制。");
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

  function loadBackgroundWhenIdle() {
    const load = () => {
      const image = new Image();
      image.onload = () => document.body.classList.add("bg-ready");
      image.src = "./assets/space-bg.jpg";
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(load, { timeout: 1600 });
      return;
    }
    setTimeout(load, 600);
  }

  loadBackgroundWhenIdle();
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
