function init() {
  const postImage = document.querySelector("#postImage");
  const preview = document.querySelector(".preview");
  const copyText = document.querySelector("#copyText");
  const copyButton = document.querySelector("#copyButton");
  const statusText = document.querySelector("#status");
  const toast = document.querySelector("#toast");

  if (!postImage || !preview || !copyText || !copyButton || !statusText || !toast) {
    console.error("Missing required UI elements.");
    return;
  }

  let toastTimer;

  function setStatus(message) {
    statusText.textContent = message;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1000);
  }

  async function copyPostText() {
    const text = copyText.value;
    let copied = false;

    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copyText.focus();
      copyText.select();
      copied = document.execCommand("copy");
    }

    if (copied) {
      setStatus("文案已复制，可以直接粘贴到小红书。");
      showToast("复制成功");
      return true;
    }

    setStatus("自动复制失败，请点击文案框后手动复制。");
    showToast("复制失败，请手动复制");
    return false;
  }

  async function render() {
    try {
      setStatus("正在获取素材...");
      const response = await fetch("/api/next");
      const data = await response.json();

      if (!data.ok) {
        preview.hidden = true;
        postImage.removeAttribute("src");
        copyText.value = data.message || "次数已用完";
        setStatus(data.message || "次数已用完");
        return;
      }

      if (data.image) {
        preview.hidden = false;
        postImage.src = data.image;
      } else {
        preview.hidden = true;
        postImage.removeAttribute("src");
      }

      copyText.value = data.text;
      setStatus("素材已就绪，请点击按钮复制文案。");
    } catch (error) {
      preview.hidden = true;
      postImage.removeAttribute("src");
      copyText.value = "素材加载失败，请稍后重试。";
      setStatus("素材加载失败，请稍后重试。");
      console.error(error);
    }
  }

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

  copyButton.addEventListener("click", copyPostText);

  loadBackgroundWhenIdle();
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
