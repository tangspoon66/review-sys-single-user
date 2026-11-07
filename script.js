function init() {
  const sectionPanel = document.querySelector("#sectionPanel");
  const sectionList = document.querySelector("#sectionList");
  const sectionHint = document.querySelector("#sectionHint");
  const copyPanel = document.querySelector("#copyPanel");
  const copyHeading = document.querySelector("#copyHeading");
  const copyText = document.querySelector("#copyText");
  const copyButton = document.querySelector("#copyButton");
  const imagePreview = document.querySelector("#imagePreview");
  const postImage = document.querySelector("#postImage");
  const exhausted = document.querySelector("#exhausted");
  const statusText = document.querySelector("#status");
  const toast = document.querySelector("#toast");

  if (!sectionPanel || !sectionList || !copyPanel || !copyText || !copyButton || !exhausted || !statusText || !toast) {
    console.error("Missing required UI elements.");
    return;
  }

  let toastTimer;
  let busy = false;
  let activeReservation = null;
  let localCopied = false;
  let copyCommitted = false;
  let commitStarted = false;
  let selectedButton = null;
  let selectedSectionId = "";

  function setStatus(message) {
    statusText.textContent = message;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1400);
  }

  function setButtonsDisabled(disabled) {
    sectionList.querySelectorAll("button").forEach((button) => {
      button.disabled = disabled;
    });
  }

  function rememberReservation(data) {
    activeReservation = {
      textId: data.textId,
      reservationToken: data.reservationToken,
    };
    localCopied = false;
    copyCommitted = false;
    commitStarted = false;
  }

  function clearPressed() {
    sectionList.querySelectorAll("button").forEach((button) => {
      button.setAttribute("aria-pressed", "false");
    });
    selectedButton = null;
    selectedSectionId = "";
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

  function hideCopy() {
    copyPanel.hidden = true;
    copyText.value = "";
    copyHeading.textContent = "笔记文案";
    imagePreview.hidden = true;
    postImage.removeAttribute("src");
  }

  function showExhausted(message, keepCopy = false) {
    const text = message || "次数已用完";
    sectionPanel.hidden = true;
    sectionHint.hidden = true;
    exhausted.hidden = false;
    exhausted.textContent = text;
    if (!keepCopy) hideCopy();
    setStatus(text);
    if (!keepCopy) clearPressed();
  }

  function showPicker() {
    exhausted.hidden = true;
    sectionPanel.hidden = false;
    sectionHint.hidden = false;
  }

  function renderSections(sections) {
    showPicker();
    sectionList.replaceChildren();
    sections.forEach((section) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "section-btn";
      button.textContent = section.name;
      button.dataset.sectionId = section.id;
      button.setAttribute("aria-pressed", section.id === selectedSectionId ? "true" : "false");
      button.addEventListener("click", () => {
        chooseSection(section, button);
      });
      sectionList.appendChild(button);
    });
    selectedButton = selectedSectionId
      ? sectionList.querySelector(`[data-section-id="${selectedSectionId}"]`)
      : null;
  }

  async function loadSections(options = {}) {
    const response = await fetch("/api/sections");
    const data = await response.json();
    if (!data.ok || !Array.isArray(data.sections) || !data.sections.length) {
      showExhausted(data.message || "次数已用完", options.keepCopy);
      return false;
    }
    renderSections(data.sections);
    if (!copyPanel.hidden) {
      setStatus(copyCommitted
        ? "文案已复制，可以直接粘贴到小红书。"
        : "文案已就绪，请点击按钮复制。复制成功后才会标记已用。");
    } else {
      setStatus("请选择一个板块");
    }
    return true;
  }

  function showCopy(section, data) {
    rememberReservation(data);
    copyHeading.textContent = section.name || data.sectionName || "笔记文案";
    copyText.value = data.text || "";
    copyPanel.hidden = false;
    if (data.image) {
      imagePreview.hidden = false;
      postImage.src = data.image;
    } else {
      imagePreview.hidden = true;
      postImage.removeAttribute("src");
    }
    sectionHint.textContent = "文案在下方。复制成功后才会标记已用，换板块不会消耗当前这条。";
    setStatus("文案已就绪，请点击按钮复制。复制成功后才会标记已用。");
    copyPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function chooseSection(section, button) {
    if (busy || !section?.id) return;
    if (selectedSectionId === section.id && activeReservation && !copyCommitted) return;
    busy = true;
    setButtonsDisabled(true);
    clearPressed();
    selectedSectionId = section.id;
    button.setAttribute("aria-pressed", "true");
    selectedButton = button;
    setStatus("正在获取文案...");

    const previous = activeReservation;
    try {
      const response = await fetch(`/api/sections/${encodeURIComponent(section.id)}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previousTextId: previous && !copyCommitted ? previous.textId : "",
          previousReservationToken: previous && !copyCommitted ? previous.reservationToken : "",
        }),
      });
      const data = await response.json();
      if (previous && !copyCommitted) activeReservation = null;

      if (!data.ok) {
        hideCopy();
        if (data.message === "次数已用完") {
          showExhausted(data.message);
          return;
        }
        setStatus(data.message || "获取失败，请重试");
        button.setAttribute("aria-pressed", "false");
        selectedButton = null;
        selectedSectionId = "";
        return;
      }

      showCopy(section, data);
    } catch (error) {
      hideCopy();
      setStatus("素材加载失败，请稍后重试。");
      button.setAttribute("aria-pressed", "false");
      selectedButton = null;
      selectedSectionId = "";
      console.error(error);
    } finally {
      busy = false;
      setButtonsDisabled(false);
      if (selectedButton) selectedButton.disabled = false;
    }
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
    const payload = activeReservation;
    try {
      const response = await fetch("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!data.ok) {
        commitStarted = false;
        if (String(data.message || "").includes("失效")) {
          activeReservation = null;
          localCopied = false;
          hideCopy();
          showToast(data.message);
          await loadSections();
          setStatus(data.message);
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
      const stillOpen = await loadSections({ keepCopy: true });
      setStatus(stillOpen ? "文案已复制，可以直接粘贴到小红书。" : "文案已复制。次数已用完。");
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
    if (copyCommitted) {
      showToast("已经复制");
      return;
    }
    if (!copyText.value) return;
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
    if (!copyText.value) return;
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
  loadSections().catch((error) => {
    sectionPanel.hidden = true;
    hideCopy();
    setStatus("素材加载失败，请稍后重试。");
    console.error(error);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
