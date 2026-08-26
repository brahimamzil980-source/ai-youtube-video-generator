#!/usr/bin/env python
from g4f.client import Client
from moviepy.editor import ImageClip, AudioFileClip, concatenate_videoclips, CompositeVideoClip, CompositeAudioClip, afx
from moviepy.video.fx.all import speedx
import requests
import asyncio
import edge_tts
import random
import numpy as np
import subprocess
from PIL import Image
import json
import logging
import multiprocessing
from multiprocessing import Process, Queue
import sys, os
import time
import shutil
from PIL import Image
from io import BytesIO
import base64
from tqdm import tqdm
from g4f import models
from urllib.parse import quote

logging.basicConfig(
    filename="ai_gen.log",
    level=logging.INFO,
    format="%(message)s"
)
os.system("python3 -m pip install g4f -U")
def log(msg):
    """Simple logging with timestamp"""
    print(f"{msg}")
    logging.info(f"{msg}")


def process_subtitles(video_file):
    """Generate subtitles using external script and burn them into the video"""
    log("\n📝 Generating subtitles...")
    try:
        # Call the local Hindi-specific script
        subprocess.run(["bash", "./gen_subtitle_hindi.sh", video_file], check=True)
        
        video_name = os.path.splitext(os.path.basename(video_file))[0]
        srt_file = f"/sdcard/aiwu/{video_name}.srt"
        
        if not os.path.exists(srt_file):
            log(f"⚠️ Subtitle file not found: {srt_file}")
            # Try alternative path if needed, but script says /sdcard/aiwu/
            return
            
        log("🔥 Burning subtitles into video with high-visibility style...")
        output_with_subs = "temp_with_subs.mp4"
        
        # Style: Yellow text, black outline, centered, at the very bottom
        # FontSize=15 and MarginV=40 for bottom placement
        style = "FontSize=15,PrimaryColour=&H00FFFF,OutlineColour=&H000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=40,MarginL=40,MarginR=40"
        
        cmd = [
            "ffmpeg", "-y", "-i", video_file,
            "-vf", f"subtitles={srt_file}:force_style='{style}'",
            "-c:a", "copy",
            output_with_subs
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            log(f"❌ ffmpeg failed: {result.stderr}")
            return

        # Replace original with subtitled version
        os.replace(output_with_subs, video_file)
        log("✅ Subtitles burned successfully!")
        
    except Exception as e:
        log(f"❌ Subtitle processing failed: {e}")


def cleanup_old_files():
    """
    Remove old generated files to avoid overwriting issues.
    Keeps only: ai_gen.py, ai_gen.log
    """
    files_to_delete = []
    
    # Find all generated files
    for f in os.listdir("."):
        # Skip the script and log file
        if f in ["ai_gen.py", "ai_gen.log",  "upload_video.py", "upload_video.py-oauth2.json", "client_secrets.json"]:
            continue
        
        # Check for generated files
        if (f.endswith(".png") or 
            f.endswith(".mp3") or 
            f.endswith(".mp4") or 
            f.endswith(".json")):
            files_to_delete.append(f)
    
    if not files_to_delete:
        log("🧹 No old generated files to clean up.")
        return
    
    log(f"\n⚠️  WARNING: Found {len(files_to_delete)} old generated file(s) that will be deleted:")
    for f in files_to_delete:
        log(f"   - {f}")
    
    log("\n❓ Delete all generated files except current script and log file? (Y/N): ")
    response = "y"
#input().strip().lower()
    
    if response == "y":
        log("\n🗑️  Deleting old files...")
        for f in files_to_delete:
            try:
                if os.path.isfile(f):
                    os.remove(f)
                    log(f"   ✅ Deleted: {f}")
                elif os.path.isdir(f):
                    shutil.rmtree(f)
                    log(f"   ✅ Deleted directory: {f}")
            except Exception as e:
                log(f"   ❌ Failed to delete {f}: {e}")
        log("✅ Cleanup complete!")
    else:
        log("\n⏭️  Skipping cleanup. Existing files may be overwritten.")

# ============ TIMEOUT CONFIGURATION ============
TEXT_TIMEOUT = 150     # 2.5 minute for text models
IMAGE_TIMEOUT = 600    # 10 minutes for image models

api_key = os.getenv("GOOGLE_IMAGE_API")


# ============ AI HORDE FUNCTIONS (MUST BE BEFORE WORKERS) ============
def submit_job_horde(prompt):
    """Submit a job to AI Horde"""
    API_KEY = os.getenv("AI_HORDE_API_KEY", "0000000000")
    SUBMIT_URL = "https://aihorde.net/api/v2/generate/async"

    HEADERS = {
        "apikey": API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "aihorde-fallback"
    }

    payload = {
        "prompt": prompt,
        "params": {}
    }

    r = requests.post(SUBMIT_URL, headers=HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()

    if "id" not in data:
        raise RuntimeError(f"Unexpected response: {data}")

    return data["id"]


def poll_status_horde(gen_id, timeout=300):
    """Poll for job status with timeout"""
    STATUS_URL = "https://aihorde.net/api/v2/generate/status/{}"
    start_time = time.time()

    while True:
        if time.time() - start_time > timeout:
            raise TimeoutError(f"AI Horde timed out after {timeout}s")
            
        r = requests.get(STATUS_URL.format(gen_id), timeout=30)
        r.raise_for_status()
        data = r.json()

        if data.get("faulted"):
            raise RuntimeError("Generation faulted")

        if data.get("done"):
            return data

        queue_pos = data.get('queue_position', data.get('waiting', '?'))
        processing = data.get('processing', 0)
        print(f"  ⏳ AI Horde: queue={queue_pos} processing={processing}")
        time.sleep(5)


def save_image_horde(gen_data, filename):
    """Save image from AI Horde response"""
    gens = gen_data.get("generations")
    if not gens:
        raise RuntimeError("No image generations found")

    img = gens[0].get("img")
    if not img:
        raise RuntimeError("No image data")

    if img.startswith("http"):
        print("  ⬇ Downloading image from URL")
        r = requests.get(img, timeout=60)
        r.raise_for_status()
        content = r.content
    else:
        print("  📦 Decoding base64 image")
        content = base64.b64decode(img)

    with open(filename, "wb") as f:
        f.write(content)

    # Verify the image is valid using our improved validation
    if not validate_image_file(filename):
        raise RuntimeError("Generated image is not valid")

    return True


def generate_image_pixazo(prompt, filename, timeout=120):
    """Generate image using Pixazo API as fallback"""
    try:
        import os
        import requests
        
        key = os.getenv("PIXAZO_API_KEY")
        
        if not key:
            print("  ❌ No PIXAZO_API_KEY found in environment variables")
            return False

        url = "https://gateway.pixazo.ai/flux-1-schnell/v1/getData"
        headers = {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "Ocp-Apim-Subscription-Key": key
        }
        data = {
            "prompt": prompt,
            "num_steps": 4,
            "seed": 15,
            "height": 512,
            "width": 512
        }

        print(f"  🚀 Trying Pixazo API...")
        response = requests.post(url, json=data, headers=headers, timeout=timeout)
        response.raise_for_status()
        
        image_url = response.json()['output']
        
        # Download the image
        r = requests.get(image_url, timeout=60)
        r.raise_for_status()
        
        with open(filename, 'wb') as w:
            w.write(r.content)
            
        # Verify the image is valid using our improved validation
        if not validate_image_file(filename):
            raise RuntimeError("Generated image is not valid")

        print(f"  ✅ Pixazo saved: {filename}")
        return True
    except Exception as e:
        print(f"  ❌ Pixazo failed: {e}")
        if os.path.exists(filename):
            try:
                os.remove(filename)
            except:
                pass
        return False


def generate_image_horde(prompt, filename, timeout=600):
    """Generate image using AI Horde as fallback"""
    try:
        print("  🚀 Submitting job to AI Horde...")
        gen_id = submit_job_horde(prompt)
        print(f"  🆔 Generation ID: {gen_id}")

        print("  🔄 Polling for result...")
        result = poll_status_horde(gen_id, timeout=timeout)

        save_image_horde(result, filename)
        print(f"  ✅ AI Horde saved: {filename}")
        return True
    except Exception as e:
        print(f"  ❌ AI Horde failed: {e}")
        if os.path.exists(filename):
            try:
                os.remove(filename)
            except:
                pass
        return False


def generate_image_pollinations(prompt, filename, timeout=120):
    """Generate image using Pollinations.ai"""
    try:
        encoded_prompt = quote(prompt, safe='')
        # Use portrait dimensions for YouTube Shorts
        url = f"https://image.pollinations.ai/prompt/{encoded_prompt}"

        print(f"  🌸 Trying Pollinations.ai...")

        response = requests.get(url, timeout=timeout)

        # Check content type
        content_type = response.headers.get('content-type', '')
        
        # Check for common error indicators in the response
        content_preview = response.content[:500].decode('utf-8', errors='ignore').lower() if response.content else ''

        # Look for error indicators in both content-type and content
        if ('html' in content_preview or
            'error' in content_preview or
            'gateway' in content_preview or
            'not found' in content_preview or
            'forbidden' in content_preview):
            raise Exception(f"Error page received: {content_type}")

        # If content-type suggests it's an image or we can't determine from content-type, save it
        if content_type.startswith('image/') or content_type == '' or content_type.startswith('application/octet-stream'):
            # Save the image
            with open(filename, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            # Verify the image using our improved validation
            if not validate_image_file(filename):
                raise Exception("Generated image is not valid")

            print(f"  ✅ Pollinations saved: {filename}")
            return True
        else:
            raise Exception(f"Unexpected content type from Pollinations: {content_type}")

    except Exception as e:
        print(f"  ❌ Pollinations failed: {e}")
        if os.path.exists(filename):
            os.remove(filename)
        return False


def generate_images_g4f(prompts, timeout=IMAGE_TIMEOUT):
    """Generate images using multiple fallback methods"""
    image_files = []

    # List of g4f models to try
    g4f_image_models = [
        models.flux,
        models.flux_schnell,
        models.sdxl_turbo,
        models.flux_pro,
        models.sd_3_5_large,
        models.flux_dev,
        models.dall_e_3,
        models.gpt_image,
    ]

    for i, prompt in enumerate(tqdm(prompts, desc="Generating images")):
        filename = f"img_{i}.png"

        # RESUME LOGIC: Check if file exists and is valid
        if os.path.exists(filename) and validate_image_file(filename):
            log(f"  ⏭️ Image {i+1} exists ({filename}), skipping generation.")
            image_files.append(filename)
            continue
        elif os.path.exists(filename):
            log(f"  ⚠️ Image {i+1} exists but is invalid, regenerating...")
            os.remove(filename)

        success = False
        enhanced_prompt = f"{prompt}, cinematic lighting, high quality, detailed, 4k, masterpiece"

        # Method 0: Try g4f auto model first with timeout
        log(f"  🔄 Image {i+1}: Trying g4f auto model (timeout={IMAGE_TIMEOUT}s)...")
        try:
            url = generate_image_with_timeout("auto", enhanced_prompt, timeout=IMAGE_TIMEOUT)

            if not url:
                raise Exception("No URL returned from auto model")

            # Download the image
            img_response = requests.get(url, timeout=60)
            img_response.raise_for_status()  # Raise an exception for bad status codes

            # Check if it's an image - more flexible approach
            content_type = img_response.headers.get('content-type', '').lower()

            # Check for common error indicators in the response
            content_preview = img_response.content[:500].decode('utf-8', errors='ignore').lower() if img_response.content else ''

            # Look for error indicators in both content-type and content
            if ('html' in content_preview or
                'error' in content_preview or
                'gateway' in content_preview or
                'not found' in content_preview or
                'forbidden' in content_preview):
                raise Exception(f"Error page received: {content_type}")

            # If content-type suggests it's an image or we can't determine from content-type, save it
            if content_type.startswith('image/') or content_type == '' or content_type.startswith('application/octet-stream'):
                # Save the image
                with open(filename, "wb") as f:
                    f.write(img_response.content)

                # Verify the image by attempting to open it
                try:
                    with Image.open(filename) as img:
                        img.verify()
                except Exception:
                    # If PIL can't verify it, check file size as a basic check
                    if os.path.getsize(filename) < 1024:  # Less than 1KB is suspicious
                        raise Exception("Downloaded file is too small to be a valid image")
                    # If file exists and has reasonable size, we'll accept it
                    pass

                image_files.append(filename)
                log(f"  ✅ Saved: {filename} (using g4f auto model)")
                success = True
            else:
                raise Exception(f"Unexpected content type from auto model: {content_type}")

        except TimeoutError as e:
            log(f"  ⏰ g4f auto model timed out after {IMAGE_TIMEOUT}s, trying next method...")
            if os.path.exists(filename):
                try:
                    os.remove(filename)
                except:
                    pass
        except Exception as e:
            log(f"  ❌ g4f auto model: {str(e)[:50]}, trying next method...")
            if os.path.exists(filename):
                try:
                    os.remove(filename)
                except:
                    pass

        # Method 1: Try direct string "flux" as second fallback
        if not success:
            log(f"  🔄 Image {i+1}: Trying direct string 'flux' (timeout={IMAGE_TIMEOUT}s)...")
            try:
                url = generate_image_with_timeout("flux", enhanced_prompt, timeout=IMAGE_TIMEOUT)

                if not url:
                    raise Exception("No URL returned")

                # Download the image
                img_response = requests.get(url, timeout=60)
                img_response.raise_for_status()  # Raise an exception for bad status codes

                # Check if it's an image - more flexible approach
                content_type = img_response.headers.get('content-type', '').lower()

                # Check for common error indicators in the response
                content_preview = img_response.content[:500].decode('utf-8', errors='ignore').lower() if img_response.content else ''

                # Look for error indicators in both content-type and content
                if ('html' in content_preview or
                    'error' in content_preview or
                    'gateway' in content_preview or
                    'not found' in content_preview or
                    'forbidden' in content_preview):
                    raise Exception(f"Error page received: {content_type}")

                # If content-type suggests it's an image or we can't determine from content-type, save it
                if content_type.startswith('image/') or content_type == '' or content_type.startswith('application/octet-stream'):
                    # Save the image
                    with open(filename, "wb") as f:
                        f.write(img_response.content)

                    # Verify the image by attempting to open it
                    try:
                        with Image.open(filename) as img:
                            img.verify()
                    except Exception:
                        # If PIL can't verify it, check file size as a basic check
                        if os.path.getsize(filename) < 1024:  # Less than 1KB is suspicious
                            raise Exception("Downloaded file is too small to be a valid image")
                        # If file exists and has reasonable size, we'll accept it
                        pass

                    image_files.append(filename)
                    log(f"  ✅ Saved: {filename} (using direct string 'flux')")
                    success = True
                else:
                    raise Exception(f"Unexpected content type: {content_type}")

            except TimeoutError as e:
                log(f"  ⏰ Direct string 'flux' timed out after {IMAGE_TIMEOUT}s, trying next method...")
                if os.path.exists(filename):
                    try:
                        os.remove(filename)
                    except:
                        pass
            except Exception as e:
                log(f"  ❌ Direct string 'flux': {str(e)[:50]}, trying next method...")
                if os.path.exists(filename):
                    try:
                        os.remove(filename)
                    except:
                        pass

        # Method 2: Try Pixazo API
        if not success:
            log(f"  🌟 Trying Pixazo API for image {i+1}...")
            if generate_image_pixazo(enhanced_prompt, filename):
                image_files.append(filename)
                success = True

        # Method 3: Try AI Horde
        if not success:
            log(f"  🤖 Trying AI Horde for image {i+1}...")
            if generate_image_horde(enhanced_prompt, filename, timeout=1200):
                image_files.append(filename)
                success = True

        # Method 4: Try multiple g4f models
        if not success:
            for model in g4f_image_models:
                if success:
                    break

                log(f"  🔄 Image {i+1}: Trying {model.name} (timeout={IMAGE_TIMEOUT}s)...")

                try:
                    url = generate_image_with_timeout(model, enhanced_prompt, timeout=IMAGE_TIMEOUT)

                    if not url:
                        raise Exception("No URL returned")

                    # Download the image
                    img_response = requests.get(url, timeout=60)
                    img_response.raise_for_status()  # Raise an exception for bad status codes

                    # Check if it's an image - more flexible approach
                    content_type = img_response.headers.get('content-type', '').lower()

                    # Check for common error indicators in the response
                    content_preview = img_response.content[:500].decode('utf-8', errors='ignore').lower() if img_response.content else ''

                    # Look for error indicators in both content-type and content
                    if ('html' in content_preview or
                        'error' in content_preview or
                        'gateway' in content_preview or
                        'not found' in content_preview or
                        'forbidden' in content_preview):
                        raise Exception(f"Error page received: {content_type}")

                    # If content-type suggests it's an image or we can't determine from content-type, save it
                    if content_type.startswith('image/') or content_type == '' or content_type.startswith('application/octet-stream'):
                        # Save the image
                        with open(filename, "wb") as f:
                            f.write(img_response.content)

                        # Verify the image by attempting to open it
                        try:
                            with Image.open(filename) as img:
                                img.verify()
                        except Exception:
                            # If PIL can't verify it, check file size as a basic check
                            if os.path.getsize(filename) < 1024:  # Less than 1KB is suspicious
                                raise Exception("Downloaded file is too small to be a valid image")
                            # If file exists and has reasonable size, we'll accept it
                            pass

                        image_files.append(filename)
                        log(f"  ✅ Saved: {filename} (using {model.name})")
                        success = True
                    else:
                        raise Exception(f"Unexpected content type: {content_type}")

                except TimeoutError as e:
                    log(f"  ⏰ {model.name} timed out after {IMAGE_TIMEOUT}s, trying next...")
                    if os.path.exists(filename):
                        try:
                            os.remove(filename)
                        except:
                            pass
                    continue
                except Exception as e:
                    log(f"  ❌ {model.name}: {str(e)[:50]}, trying next...")
                    if os.path.exists(filename):
                        try:
                            os.remove(filename)
                        except:
                            pass
                    continue

        # Method 5: Try Pollinations.ai as fallback
        if not success:
            log(f"  🌸 Trying Pollinations.ai for image {i+1}...")
            if generate_image_pollinations(enhanced_prompt, filename):
                image_files.append(filename)
                success = True

        # Method 6: Create placeholder if everything fails
        if not success:
            log(f"  ❌ All methods failed for image {i+1}, creating placeholder...")
            create_placeholder_image(filename, f"Image {i+1}")
            image_files.append(filename)

    return image_files


def validate_image_file(filename):
    """Validate if a file is a valid image by attempting to open it with PIL"""
    try:
        with Image.open(filename) as img:
            img.verify()
        return True
    except Exception:
        # Check if file exists and has reasonable size
        if os.path.exists(filename):
            file_size = os.path.getsize(filename)
            # If file is reasonably sized (> 1KB) we'll consider it valid
            # This handles cases where PIL can't verify but the file is still an image
            return file_size > 1024
        return False


def create_placeholder_image(filename, text=""):
    """Create a gradient placeholder image"""
    from PIL import ImageDraw, ImageFont

    width, height = 1080, 1920

    # Create gradient background
    img = Image.new('RGB', (width, height))
    pixels = img.load()

    for y in range(height):
        r = int(20 + (y / height) * 30)
        g = int(20 + (y / height) * 40)
        b = int(40 + (y / height) * 60)
        for x in range(width):
            pixels[x, y] = (r, g, b)

    # Add text if provided
    if text:
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 48)
        except:
            font = ImageFont.load_default()

        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        x = (width - text_width) // 2
        y = (height - text_height) // 2
        draw.text((x, y), text, fill=(100, 100, 120), font=font)

    img.save(filename, 'PNG')

    # Verify the placeholder image is valid
    if not validate_image_file(filename):
        # If validation fails, create a simple solid color image
        fallback_img = Image.new('RGB', (width, height), color=(50, 50, 70))
        fallback_img.save(filename, 'PNG')

    return filename


def standardize_image_filenames(image_files):
    """Standardize image filenames to img_0.png, img_1.png, etc."""
    standardized_files = []
    for i, file_path in enumerate(image_files):
        new_filename = f"img_{i}.png"
        if file_path != new_filename:
            shutil.move(file_path, new_filename)
            standardized_files.append(new_filename)
        else:
            standardized_files.append(file_path)
    return standardized_files


def is_valid_response(text):
    """Validate if the generated AI response is valid and doesn't contain error messages"""
    if not text or len(text) < 20:
        return False
    
    # List of phrases that indicate invalid or unwanted AI responses
    bad_indicators = [
        "quote expired", "sign up", "api key", "limit reached", 
        "trial ended", "subscribe", "payment", "access denied", 
        "error", "server busy", "rate limit", "insufficient balance",
        "chat.g4f", "llmplayground.net"
    ]
    
    text_lower = text.lower()
    for indicator in bad_indicators:
        if indicator in text_lower:
            return False
            
    return True


# ============ MULTIPROCESSING WORKER FUNCTIONS ============
def _text_worker(queue, model, messages):
    """Worker function for text generation - runs in separate process"""
    try:
        from g4f.client import Client
        client = Client()
        response = client.chat.completions.create(
            model=model,
            messages=messages
        )
        content = str(response.choices[0].message.content)
        queue.put(('success', content))
    except Exception as e:
        queue.put(('error', str(e)))


def run_with_timeout(worker_func, timeout, *args):
    """
    Run a worker function with REAL timeout using multiprocessing.
    """
    queue = multiprocessing.Queue()
    process = multiprocessing.Process(target=worker_func, args=(queue, *args))
    process.start()

    process.join(timeout=timeout)

    if process.is_alive():
        log(f"    ⚠️ Process still running, terminating...")
        process.terminate()
        process.join(timeout=5)

        if process.is_alive():
            log(f"    ⚠️ Force killing process...")
            process.kill()
            process.join(timeout=3)

        raise TimeoutError(f"Timed out after {timeout}s")

    if queue.empty():
        raise Exception("Process completed but no result returned")

    status, result = queue.get_nowait()

    if status == 'error':
        raise Exception(result)

    return result


def generate_text_with_timeout(model, messages, timeout):
    """Generate text with proper timeout"""
    return run_with_timeout(_text_worker, timeout, model, messages)

def generate_with_op(what):
    """Generate text using OpenRouter as a primary option"""
    openrouter_api_key = os.getenv("OPENROUTER_API_KEY")
    if not openrouter_api_key:
        log("  ⚠️ OPENROUTER_API_KEY not found in environment variables.")
        return None
        
    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {openrouter_api_key}",
        "Content-Type": "application/json",
    }
    
    payload = {
        "model": "openai/gpt-oss-120b:free",
        "messages": [
            {"role": "user", "content": what}
        ],
        "reasoning": {
            "enabled": True
        }
    }
    
    try:
        log("  🚀 Trying OpenRouter (openai/gpt-oss-120b:free)...")
        response = requests.post(url, headers=headers, json=payload, timeout=TEXT_TIMEOUT)
        response.raise_for_status()
        data = response.json()
        
        if "choices" in data and len(data["choices"]) > 0:
            content = data["choices"][0]["message"]["content"]
            return content
        else:
            log(f"  ⚠️ OpenRouter returned unexpected format: {data}")
            return None
    except Exception as e:
        log(f"  ❌ OpenRouter failed: {str(e)[:80]}")
        return None
# ============ IMAGE GENERATION WITH TIMEOUT ============
def _image_worker(queue, model, prompt, response_format="url"):
    """Worker function for image generation - runs in separate process"""
    try:
        from g4f.client import Client
        client = Client()
        response = client.images.generate(
            model=model,
            prompt=prompt,
            response_format=response_format
        )
        url = response.data[0].url
        queue.put(('success', url))
    except Exception as e:
        queue.put(('error', str(e)))


def generate_image_with_timeout(model, prompt, timeout, response_format="url"):
    """Generate image with proper timeout using multiprocessing"""
    return run_with_timeout(_image_worker, timeout, model, prompt, response_format)


# ============ MAIN EXECUTION ============
if __name__ == "__main__":
    multiprocessing.freeze_support()

    # Clean up old files first to avoid overwriting
    cleanup_old_files()

    client = Client()

    # ============ CONFIGURATION ============
    VIDEO_FORMAT = "portrait"
    MAX_DURATION = 59
    MAX_SPEED = 2.0

    if VIDEO_FORMAT == "portrait":
        VIDEO_WIDTH = 1080
        VIDEO_HEIGHT = 1920
    else:
        VIDEO_WIDTH = 1920
        VIDEO_HEIGHT = 1080

    # ============ AI MODELS CONFIGURATION ============
    base_backup_models = [
        models.gemini_2_5_pro,
        models.gpt_4o, 
        models.qwen_2_5_max, 
        models.gpt_4_1, 
        models.gemini_2_0_flash, 
        models.deepseek_v3_0324, 
        models.llama_2_70b,
        models.gpt_4,
        models.deepseek_r1_0528_turbo,
        models.deepseek_r1,
        models.deepseek_v3_0324_turbo,
        models.gpt_4_1_mini,
        models.gpt_4_1_nano,
        models.gpt_oss_120b,
        models.gpt_4o_mini,
        models.gemini_2_0_flash_thinking,
        models.gemini_2_5_flash,
        models.gemma_3_27b,
        models.qwen_2_5_72b,
        models.qwen_3_235b,
        models.grok_2,
        models.grok_3,
        models.grok_3_r1
    ]
    NORMAL_MODEL = models.gpt_4_5

    # ============ STEP 0: Manual Story Prompt ============
    log("\n" + "="*60)
    log("🤖 CHATGPT STORY PROMPT")
    log("="*60)
    log("\nCopy and paste this prompt into ChatGPT/Claude to get a viral story:")
    log("\n------------------------------------------------------------")
    log("Write a short, viral Hindi story (approx 150-180 words) for a YouTube Short. ")
    log("The story should be engaging, have a strong emotional hook in the first 3 seconds, ")
    log("and a surprising or meaningful ending. Use simple but powerful Hindi.")
    log("------------------------------------------------------------")
    
    log("\n1. Copy the prompt above.")
    log("2. Paste it into ChatGPT.")
    log("3. Copy the Hindi story generated.")
    log("4. Paste the story into the file: hindi_story.txt")
    log("5. Save the file.")
    
    STORY_FILE = "hindi_story.txt"
    if not os.path.exists(STORY_FILE):
        log(f"❌ Error: {STORY_FILE} not found!")
        sys.exit(1)        
    
    with open(STORY_FILE, "r", encoding="utf-8") as f:
        hindi_story = f.read().strip()
        
    if not hindi_story:
        log(f"❌ Error: {STORY_FILE} is empty!")
        input("\n👉 Once you've saved the story in hindi_story.txt, press [ENTER] to continue...")

    # ============ STEP 1: Read Story from File ============
    log("\n📝 Reading story from hindi_story.txt...")
    
    
    with open(STORY_FILE, "r", encoding="utf-8") as f:
        hindi_story = f.read().strip()
        
    if not hindi_story:
        log(f"❌ Error: {STORY_FILE} is empty!")
        sys.exit(1)
        
    log(f"✅ Story read successfully from {STORY_FILE}")
    log(f"\n📖 STORY:\n{hindi_story}")
    
    # Empty the file after reading
    with open(STORY_FILE, "w", encoding="utf-8") as f:
        f.write("")
    log(f"🧹 Emptied {STORY_FILE}")
    
    success = True 

    #input("\n✅ Press Enter if story is correct...")


    # ============ STEP 2: Generate Narration FIRST ============
    log("\n🎙️ Generating narration...")
    VOICE = random.choice(["hi-IN-MadhurNeural", "hi-IN-SwaraNeural"])

    async def make_tts(text):
        communicate = edge_tts.Communicate(text, VOICE)
        await communicate.save("narration.mp3")

    asyncio.run(make_tts(hindi_story))
    log("✅ Saved: narration.mp3")

    audio = AudioFileClip("narration.mp3")
    original_duration = audio.duration
    log(f"⏱️ Narration duration: {original_duration:.2f} seconds ({original_duration/60:.2f} min)")

    if original_duration > MAX_DURATION:
        speed_factor = min(original_duration / MAX_DURATION, MAX_SPEED)
        final_duration = original_duration / speed_factor
        log(f"⚡ Video too long! Will speed up by {speed_factor:.2f}x")
        log(f"⏱️ Final duration will be: {final_duration:.2f} seconds ({final_duration/60:.2f} min)")
    else:
        speed_factor = 1.0
        final_duration = original_duration


    # ============ STEP 3: Generate YouTube Metadata ============
    log("\n📺 Generating YouTube metadata...")
    success = False
    metadata_content = None

    metadata_prompt = f"""Based on this Hindi story, generate YouTube Shorts metadata in JSON format:

Story: {hindi_story}

Generate:
1. title: Viral, click-worthy Hindi title with emoji (max 60 chars). Use a powerful hook!
2. description: Engaging Hindi description. START with a "Did you know?" or "Wait for the end" style hook. Include call to action (150-200 words).
3. tags: List of 15-20 high-traffic relevant tags in Hindi and English for SEO.

Return ONLY valid JSON like:
{{
    "title": "...",
    "description": "...",
    "tags": ["tag1", "tag2", ...]
}}"""

    # Try OpenRouter first
    try:
        metadata_content = generate_with_op(metadata_prompt)
        if is_valid_response(metadata_content):
            log(f"  ✅ Success with OpenRouter for metadata")
            success = True
    except Exception as e:
        log(f"  ❌ OpenRouter for metadata error: {str(e)[:80]}")

    if not success:
        # Try auto model first for metadata
        log(f"  🔄 Trying g4f auto model for metadata generation (timeout: {TEXT_TIMEOUT}s)...")
        try:
            from g4f.client import Client
            client = Client()
            response = client.chat.completions.create(
                model="auto",
                messages=[{
                    "role": "user",
                    "content": metadata_prompt
                }],
                timeout=TEXT_TIMEOUT
            )
            metadata_content = response.choices[0].message.content
            if is_valid_response(metadata_content):
                log(f"  ✅ Success with g4f auto model for metadata")
                success = True
            else:
                log(f"  ⚠️ Invalid content from auto model for metadata, trying backup...")
                raise Exception("Invalid metadata content detected")
            # Keep the original NORMAL_MODEL since auto is just a fallback strategy
        except Exception as e:
            log(f"  ❌ g4f auto model for metadata: {str(e)[:80]}, trying next...")
            # Continue with the regular model list
            all_models = [NORMAL_MODEL] + base_backup_models.copy()
            for model in all_models:
                if success:
                    break

                log(f"  🔄 Trying model: {model.name} (timeout: {TEXT_TIMEOUT}s)...")

                try:
                    messages = [{
                        "role": "user",
                        "content": metadata_prompt
                    }]

                    temp_metadata = generate_text_with_timeout(model, messages, TEXT_TIMEOUT)
                    if is_valid_response(temp_metadata):
                        metadata_content = temp_metadata
                        log(f"  ✅ Success with model: {model.name}")
                        success = True
                        NORMAL_MODEL = model
                    else:
                        log(f"  ⚠️ Invalid content from {model.name} for metadata, trying next...")
                        continue

                except TimeoutError as e:
                    log(f"  ⏰ {model.name}: {e}, trying next...")
                    continue
                except Exception as e:
                    log(f"  ❌ {model.name}: {str(e)[:80]}, trying next...")
                    continue

    try:
        json_str = metadata_content
        if "```json" in json_str:
            json_str = json_str.split("```json")[1].split("```")[0]
        elif "```" in json_str:
            json_str = json_str.split("```")[1].split("```")[0]
        
        youtube_metadata = json.loads(json_str.strip())
        log("\n📺 YOUTUBE METADATA:")
        log(f"📌 Title: {youtube_metadata['title']}")
        log(f"📝 Description: {youtube_metadata['description'][:100]}...")
        log(f"🏷️ Tags: {', '.join(youtube_metadata['tags'][:10])}...")
        
        with open("youtube_metadata.json", "w", encoding="utf-8") as f:
            json.dump(youtube_metadata, f, ensure_ascii=False, indent=2)
        log("✅ Saved: youtube_metadata.json")
        
    except Exception as e:
        log(f"⚠️ Could not parse metadata: {e}")
        youtube_metadata = {
            "title": "Hindi Story | हिंदी कहानी 📖",
            "description": hindi_story[:200],
            "tags": ["hindi story", "हिंदी कहानी", "moral story", "youtube shorts"]
        }


    # ============ STEP 4: Generate Image Prompts ============
    log("\n🖼️ Generating image prompts...")
    
    image_prompts = []
    max_retries = 3
    retry_count = 0
    
    while len(image_prompts) < 7 and retry_count < max_retries:
        if retry_count > 0:
            log(f"\n⚠️ Only {len(image_prompts)} prompts generated. Retrying image prompt generation (Attempt {retry_count + 1})...")
            
        success = False
        img_prompt_content = None

        img_prompt_instructions = f"""Based on this Hindi story, create exactly 8 detailed image prompts in ENGLISH.

IMPORTANT: Images will be in PORTRAIT format (9:16 ratio) for YouTube Shorts.
- Design compositions that work well in vertical/portrait orientation
- Focus on single subjects or vertical scenes
- Include close-up shots of characters
- Each prompt on a new line
- No numbering, no dashes, no formatting
- Make them visual, cinematic, high quality descriptions
- Include lighting, mood, style details
- Add "portrait orientation, vertical composition" to each

Story: {hindi_story}"""

        # Try OpenRouter first
        try:
            img_prompt_content = generate_with_op(img_prompt_instructions)
            if is_valid_response(img_prompt_content):
                log(f"  ✅ Success with OpenRouter for image prompts")
                success = True
        except Exception as e:
            log(f"  ❌ OpenRouter for image prompts error: {str(e)[:80]}")

        if not success:
            # Try auto model first for image prompts
            log(f"  🔄 Trying g4f auto model for image prompts generation (timeout: {TEXT_TIMEOUT}s)...")
            try:
                from g4f.client import Client
                client = Client()
                response = client.chat.completions.create(
                    model="auto",
                    messages=[{
                        "role": "user",
                        "content": img_prompt_instructions
                    }],
                    timeout=TEXT_TIMEOUT
                )
                img_prompt_content = response.choices[0].message.content
                if is_valid_response(img_prompt_content):
                    log(f"  ✅ Success with g4f auto model for image prompts")
                    success = True
                else:
                    log(f"  ⚠️ Invalid content from auto model for image prompts, trying backup...")
                    raise Exception("Invalid image prompt content detected")
            except Exception as e:
                log(f"  ❌ g4f auto model for image prompts: {str(e)[:80]}, trying next...")
                # Continue with the regular model list
                all_models = [NORMAL_MODEL] + base_backup_models.copy()
                for model in all_models:
                    if success:
                        break

                    log(f"  🔄 Trying model: {model.name} (timeout: {TEXT_TIMEOUT}s)...")

                    try:
                        messages = [{
                            "role": "user",
                            "content": img_prompt_instructions
                        }]

                        temp_img_prompts = generate_text_with_timeout(model, messages, TEXT_TIMEOUT)
                        if is_valid_response(temp_img_prompts):
                            img_prompt_content = temp_img_prompts
                            log(f"  ✅ Success with model: {model.name}")
                            success = True
                            NORMAL_MODEL = model
                        else:
                            log(f"  ⚠️ Invalid content from {model.name} for image prompts, trying next...")
                            continue

                    except TimeoutError as e:
                        log(f"  ⏰ {model.name}: {e}, trying next...")
                        continue
                    except Exception as e:
                        log(f"  ❌ {model.name}: {str(e)[:80]}, trying next...")
                        continue

        if success and img_prompt_content:
            raw_prompts = img_prompt_content.replace("Want best roleplay experience?\nhttps://llmplayground.net", "").strip().split("\n")

            current_prompts = []
            for p in raw_prompts:
                cleaned = p.strip().lstrip("0123456789.-)*:").strip()
                if cleaned and len(cleaned) > 20 and not cleaned.startswith("**"):
                    if "portrait" not in cleaned.lower():
                        cleaned += ", portrait orientation, vertical composition, 9:16 aspect ratio"
                    current_prompts.append(cleaned)
            
            # Update image_prompts if we got more than before
            if len(current_prompts) > len(image_prompts):
                image_prompts = current_prompts[:8]
        
        retry_count += 1

    if len(image_prompts) < 7:
        log("❌ Failed to generate enough image prompts. Exiting.")
        sys.exit(1)

    log(f"\n📝 Generated {len(image_prompts)} prompts:")
    for i, p in enumerate(image_prompts):
        log(f"  {i+1}. {p[:70]}...")
    	
    # ============ STEP 5: Generate Images ============
    log(f"\n🎨 Generating images...")
    log(f"⏱️ Using multiple fallback methods (g4f → Pollinations → AI Horde)")

    image_files = generate_images_g4f(image_prompts, IMAGE_TIMEOUT)

    if len(image_files) < 5:
        log("❌ Not enough images generated. Exiting.")
        sys.exit(1)


    # ============ STEP 6: Create Dynamic Slideshow ============
    log("\n🎬 Creating dynamic video slideshow...")

    def resize_image_for_video(img_path, target_size=(VIDEO_WIDTH, VIDEO_HEIGHT)):
        """Resize and crop image to fit portrait video dimensions"""
        img = Image.open(img_path)
        img = img.convert("RGB")
        
        target_ratio = target_size[0] / target_size[1]
        img_ratio = img.width / img.height
        
        if img_ratio > target_ratio:
            new_width = int(img.height * target_ratio)
            left = (img.width - new_width) // 2
            img = img.crop((left, 0, left + new_width, img.height))
        else:
            new_height = int(img.width / target_ratio)
            top = (img.height - new_height) // 2
            img = img.crop((0, top, img.width, top + new_height))
        
        img = img.resize(target_size, Image.LANCZOS)
        return np.array(img)


    def create_zoom_clip(image_path, duration, zoom_type="in", zoom_amount=0.15):
        """Create a clip with smooth zoom (Ken Burns) effect"""
        from moviepy.editor import VideoClip
        
        base_img = resize_image_for_video(image_path)
        h, w = base_img.shape[:2]
        
        def make_frame(t):
            progress = t / duration
            
            if zoom_type == "in":
                zoom = 1 + (zoom_amount * progress)
            else:
                zoom = (1 + zoom_amount) - (zoom_amount * progress)
            
            new_w = int(w / zoom)
            new_h = int(h / zoom)
            
            left = (w - new_w) // 2
            top = (h - new_h) // 2
            
            left = max(0, min(left, w - new_w))
            top = max(0, min(top, h - new_h))
            
            cropped = base_img[top:top+new_h, left:left+new_w]
            
            pil_img = Image.fromarray(cropped)
            pil_img = pil_img.resize((w, h), Image.LANCZOS)
            
            return np.array(pil_img)
        
        clip = VideoClip(make_frame, duration=duration)
        return clip


    def create_pan_clip(image_path, duration, direction="up"):
        """Create a clip with vertical pan effect (better for portrait)"""
        from moviepy.editor import VideoClip
        
        img = Image.open(image_path).convert("RGB")
        
        target_w = VIDEO_WIDTH
        target_h = VIDEO_HEIGHT
        pan_extra = 300
        
        scale = target_w / img.width
        new_h = int(img.height * scale)
        new_w = target_w
        
        if new_h < target_h + pan_extra * 2:
            scale = (target_h + pan_extra * 2) / img.height
            new_w = int(img.width * scale)
            new_h = target_h + pan_extra * 2
        
        img = img.resize((new_w, new_h), Image.LANCZOS)
        
        if new_w > target_w:
            left = (new_w - target_w) // 2
            img = img.crop((left, 0, left + target_w, new_h))
            new_w = target_w
        
        base_img = np.array(img)
        h, w = base_img.shape[:2]
        
        def make_frame(t):
            progress = t / duration
            
            max_offset = max(0, h - target_h)
            
            if direction == "up":
                y_offset = int((1 - progress) * max_offset)
            else:
                y_offset = int(progress * max_offset)
            
            y_offset = max(0, min(y_offset, h - target_h))
            x_offset = max(0, (w - target_w) // 2)
            
            frame = base_img[y_offset:y_offset + target_h, x_offset:x_offset + target_w]
            
            if frame.shape[0] != target_h or frame.shape[1] != target_w:
                pil_frame = Image.fromarray(frame)
                pil_frame = pil_frame.resize((target_w, target_h), Image.LANCZOS)
                frame = np.array(pil_frame)
            
            return frame
        
        clip = VideoClip(make_frame, duration=duration)
        return clip


    def create_static_clip(image_path, duration):
        """Create a simple static clip as fallback"""
        base_img = resize_image_for_video(image_path)
        clip = ImageClip(base_img).set_duration(duration)
        return clip


    num_images = len(image_files)
    min_clip_duration = 3.5
    max_clip_duration = 6.0

    clips = []
    current_time = 0
    last_used_indices = []
    effect_types = ["zoom_in", "zoom_out", "pan_up", "pan_down"]

    log(f"\n📊 Building {original_duration:.1f}s slideshow from {num_images} images...")
    log(f"📐 Format: {VIDEO_WIDTH}x{VIDEO_HEIGHT} (Portrait/Shorts)")

    clip_num = 1
    while current_time < original_duration:
        remaining = original_duration - current_time
        
        if remaining <= max_clip_duration:
            duration = remaining
        else:
            duration = random.uniform(min_clip_duration, min(max_clip_duration, remaining - min_clip_duration))
        
        if duration < 1:
            break
        
        if num_images >= 4:
            available = [i for i in range(num_images) if i not in last_used_indices[-2:]]
        elif num_images >= 2:
            available = [i for i in range(num_images) if i != last_used_indices[-1]] if last_used_indices else list(range(num_images))
        else:
            available = list(range(num_images))
        
        if not available:
            available = list(range(num_images))
        
        img_idx = random.choice(available)
        last_used_indices.append(img_idx)
        
        effect = effect_types[clip_num % len(effect_types)]
        img_path = image_files[img_idx]
        
        try:
            if effect == "zoom_in":
                clip = create_zoom_clip(img_path, duration, "in")
            elif effect == "zoom_out":
                clip = create_zoom_clip(img_path, duration, "out")
            elif effect == "pan_up":
                clip = create_pan_clip(img_path, duration, "up")
            else:
                clip = create_pan_clip(img_path, duration, "down")
            
            clips.append(clip)
            log(f"  📸 Clip {clip_num}: {img_path} | {duration:.2f}s | {effect}")
            
        except Exception as e:
            log(f"  ⚠️ Effect failed, using static: {e}")
            clip = create_static_clip(img_path, duration)
            clips.append(clip)
            log(f"  📸 Clip {clip_num}: {img_path} | {duration:.2f}s | static")
        
        current_time += duration
        clip_num += 1


    # ============ STEP 7: Combine Everything ============
    log("\n🔧 Combining clips...")
    final_video = concatenate_videoclips(clips, method="chain")

    log("🔊 Adding narration audio and background music...")
    
    # Load narration
    narration_audio = audio
    
    # Try to add background music
    bg_music_dir = "/sdcard/ALL_PYTHON_PROGRAMs/bgMusics/"
    bg_music_files = []
    if os.path.exists(bg_music_dir):
        bg_music_files = [os.path.join(bg_music_dir, f) for f in os.listdir(bg_music_dir) if f.endswith(".mp3")]
    
    if bg_music_files:
        try:
            bg_music_path = random.choice(bg_music_files)
            log(f"   🎵 Adding background music: {os.path.basename(bg_music_path)}")
            bg_audio = AudioFileClip(bg_music_path)
            
            # Loop bg music if shorter than video, or trim if longer
            if bg_audio.duration < final_video.duration:
                bg_audio = bg_audio.fx(afx.audio_loop, duration=final_video.duration)
            else:
                bg_audio = bg_audio.subclip(0, final_video.duration)
            
            # Reduce volume of background music (12% volume is usually good)
            bg_audio = bg_audio.volumex(0.12)
            
            final_audio = CompositeAudioClip([narration_audio, bg_audio])
            final_video = final_video.set_audio(final_audio)
        except Exception as e:
            log(f"   ⚠️ Could not add background music: {e}")
            final_video = final_video.set_audio(narration_audio)
    else:
        final_video = final_video.set_audio(narration_audio)


    # ============ STEP 8: Speed Up if Needed ============
    if speed_factor > 1.0:
        log(f"\n⚡ Speeding up video by {speed_factor:.2f}x...")
        final_video = speedx(final_video, factor=speed_factor)
        log(f"✅ New duration: {final_video.duration:.2f}s")

    log(f"\n📊 Final Video duration: {final_video.duration:.2f}s")
    log(f"📐 Resolution: {VIDEO_WIDTH}x{VIDEO_HEIGHT}")

    # Safety trim to avoid MoviePy IndexError at the very last frame
    final_video = final_video.subclip(0, final_video.duration - 0.1)

    # ============ STEP 9: Export Final Video ============
    log("\n💾 Exporting final video (this may take a while)...")

    output_filename = "ai_story_shorts.mp4"
    final_video.write_videofile(
        output_filename, 
        fps=24,
        codec='libx264', 
        audio_codec='aac',
        threads=1,
        preset='veryfast',
        bitrate="8000k"
    )

    audio.close()
    final_video.close()
    for clip in clips:
        try:
            clip.close()
        except:
            pass

    # ============ STEP 10: Process Subtitles ============
    process_subtitles(output_filename)


    # ============ STEP 11: Generate Upload Instructions ============
    log("\n" + "="*60)
    log("🎬 SUCCESS! Final video saved: " + output_filename)
    log("="*60)

    log(f"\n📊 VIDEO STATS:")
    log(f"   Duration: {final_duration:.2f} seconds ({final_duration/60:.2f} min)")
    log(f"   Resolution: {VIDEO_WIDTH}x{VIDEO_HEIGHT} (YouTube Shorts)")
    log(f"   Images used: {num_images}")
    log(f"   Total clips: {len(clips)}")
    if speed_factor > 1:
        log(f"   Speed: {speed_factor:.2f}x")

    log(f"\n📺 YOUTUBE UPLOAD INFO:")
    log(f"   Title: {youtube_metadata['title']}")
    log(f"\n   Description (copy this):")
    log("-"*40)
    log(youtube_metadata['description'])
    log("-"*40)
    log(f"\n   Tags: {', '.join(youtube_metadata['tags'])}")

    log(f"\n📁 Files created:")
    log(f"   - {output_filename} (main video)")
    log(f"   - youtube_metadata.json (title, description, tags)")
    log(f"   - narration.mp3 (audio file)")
    log(f"   - img_0.png to img_{num_images-1}.png (images)")

    log("\n" + "="*60)
    log("🚀 Ready to upload to YouTube Shorts!")
    log("="*60)

    # ============ STEP 11: Upload to YouTube ============
    log("\n📤 Uploading video to YouTube...")
    
    upload_title = youtube_metadata['title']
    upload_description = youtube_metadata['description']
    upload_tags = ",".join(youtube_metadata['tags'])
    
    log(f"   Title: {upload_title}")
    log(f"   Tags: {upload_tags}")
    
    try:
        result = subprocess.run(
            [
                sys.executable,
                "upload_video.py",
                "--file", output_filename,
                "--title", upload_title,
                "--description", upload_description,
                "--keywords", upload_tags,
                "--category", "22",
                "--privacyStatus", "public"
            ],
            capture_output=False,
            text=True
        )
        
        if result.returncode == 0:
            log("\n✅ Video successfully uploaded to YouTube!")
        else:
            log(f"\n⚠️ Upload completed with return code: {result.returncode}")
    except FileNotFoundError:
        log("\n⚠️ upload_video.py not found. Skipping YouTube upload.")
        log("   Make sure upload_video.py is in the same directory.")
    except Exception as e:
        log(f"\n❌ Upload failed: {e}")
        log("   You can manually upload using: python upload_video.py --file ai_story_shorts.mp4")
