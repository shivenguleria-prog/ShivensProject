// viewer.js
document.addEventListener('DOMContentLoaded', async () => {
    const imageElement = document.getElementById('capturedImage');
    const toolbar = document.getElementById('toolbar');
    const message = document.getElementById('message');
    const saveCropBtn = document.getElementById('saveCropBtn');
    
    let cropper = null;
    let isCropping = false;

    message.textContent = 'Fetching image from storage...';
    
    // 1. Retrieve Data URL from storage
    const storageKey = 'fpc_latest_img';
    const result = await chrome.storage.local.get(storageKey);
    const dataUrl = result[storageKey];

    if (!dataUrl) {
        message.textContent = 'Error: No image data found. Please run the capture again.';
        return;
    }

    // Clear storage after retrieval
    await chrome.storage.local.remove(storageKey);

    message.textContent = 'Initializing viewer...';
    imageElement.src = dataUrl;

    // Wait for image to load before initializing cropper
    imageElement.onload = () => {
        message.textContent = 'Ready for edit.';
        
        // 2. Initialize Cropper.js for Pan and Zoom
        // The Cropper.js library also handles pan and zoom
        cropper = new Cropper(imageElement, {
            viewMode: 0, // No restriction
            dragMode: 'move', // Allows panning
            autoCrop: false, // Start without an active crop area
            responsive: true,
            background: false,
            wheelZoomRatio: 0.1 // Adjust zoom sensitivity
        });

        // 3. Setup event listeners
        document.getElementById('zoomInBtn').addEventListener('click', () => {
            if (cropper) cropper.zoom(0.1);
        });

        document.getElementById('zoomOutBtn').addEventListener('click', () => {
            if (cropper) cropper.zoom(-0.1);
        });

        document.getElementById('cropBtn').addEventListener('click', () => {
            isCropping = !isCropping;
            if (isCropping) {
                // Change mode to crop
                cropper.setDragMode('crop');
                cropper.crop(); // Show the crop area
                saveCropBtn.style.display = 'inline-block';
                document.getElementById('cropBtn').textContent = '❌ Cancel Crop';
            } else {
                // Change mode back to pan/move
                cropper.setDragMode('move');
                cropper.clear(); // Hide the crop area
                saveCropBtn.style.display = 'none';
                document.getElementById('cropBtn').textContent = '✂️ Crop';
            }
        });

        saveCropBtn.addEventListener('click', () => {
            if (cropper && isCropping) {
                message.textContent = 'Saving cropped image...';
                
                // Get the cropped canvas
                const croppedCanvas = cropper.getCroppedCanvas();

                // Convert canvas to a blob for download
                croppedCanvas.toBlob((blob) => {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `cropped_${Date.now()}.jpg`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    
                    message.textContent = 'Cropped image downloaded.';
                    
                    // Reset to move mode after save
                    cropper.setDragMode('move');
                    cropper.clear();
                    isCropping = false;
                    saveCropBtn.style.display = 'none';
                    document.getElementById('cropBtn').textContent = '✂️ Crop';
                    
                }, 'image/jpeg', 0.95);
            }
        });
    };
});
