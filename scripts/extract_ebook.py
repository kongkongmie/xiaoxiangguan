#!/usr/bin/env python3
"""Extract EPUB spine content, or convert DRM-free AZW3 with Calibre first."""
from __future__ import annotations
import argparse, html, json, os, posixpath, re, shutil, subprocess, tempfile, zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote
from xml.etree import ElementTree as ET

class EbookError(RuntimeError): pass
def local(tag): return tag.rsplit("}", 1)[-1]

class TextExtractor(HTMLParser):
    blocks={"article","aside","blockquote","dd","div","dl","dt","figcaption","figure","footer","header","li","main","p","pre","section","table","td","th","tr"}
    def __init__(self): super().__init__(convert_charrefs=True); self.parts=[]; self.skip=0; self.heading=None; self.title=""
    def handle_starttag(self, tag, attrs):
        tag=tag.lower()
        if tag in {"head","script","style"}: self.skip+=1; return
        if self.skip: return
        if tag in self.blocks: self.parts.append("\n\n")
        elif tag=="br": self.parts.append("\n")
        elif re.fullmatch(r"h[1-6]",tag): self.parts.append("\n\n"); self.heading=[]
        elif tag=="rt": self.parts.append("（")
        elif tag=="img":
            alt=dict(attrs).get("alt") or ""; self.parts.append(f"[图片：{alt}]" if alt else "[图片]")
    def handle_endtag(self, tag):
        tag=tag.lower()
        if tag in {"head","script","style"}: self.skip=max(0,self.skip-1); return
        if self.skip: return
        if tag in self.blocks: self.parts.append("\n\n")
        elif re.fullmatch(r"h[1-6]",tag):
            if not self.title: self.title="".join(self.heading or []).strip()
            self.heading=None; self.parts.append("\n\n")
        elif tag=="rt": self.parts.append("）")
    def handle_data(self,data):
        if self.skip: return
        text=re.sub(r"\s+"," ",html.unescape(data))
        if not text.strip(): return
        if self.heading is not None: self.heading.append(text)
        self.parts.append(text)
    def text(self):
        value="".join(self.parts); value=re.sub(r"[ \t]+\n","\n",value); value=re.sub(r"\n{3,}","\n\n",value)
        return value.strip()+"\n"

def xml_member(archive,name):
    try: return ET.fromstring(archive.read(name))
    except RuntimeError as exc: raise EbookError("电子书可能带有 DRM 或加密，已停止处理。") from exc
    except Exception as exc: raise EbookError(f"无法读取 EPUB 结构：{name}") from exc
def text_member(archive,name):
    raw=archive.read(name)
    for enc in ("utf-8-sig","utf-16","shift_jis"):
        try: return raw.decode(enc)
        except UnicodeDecodeError: pass
    return raw.decode("utf-8",errors="replace")
def meta(opf,name):
    for element in opf.iter():
        if local(element.tag)==name and element.text: return element.text.strip()
    return ""

def _toc_href(base_dir,value,opf_dir):
    value=unquote((value or "").split("#",1)[0])
    if not value: return ""
    full=posixpath.normpath(posixpath.join(base_dir,value))
    return posixpath.relpath(full,opf_dir or ".")

def read_toc(archive,opf,opf_dir,manifest):
    """Return the EPUB navigation tree as a stable flattened hierarchy."""
    spine_element=next((x for x in opf.iter() if local(x.tag)=="spine"),None)
    toc_id=spine_element.attrib.get("toc","") if spine_element is not None else ""
    toc_item=manifest.get(toc_id)
    if not toc_item:
        toc_item=next((item for item in manifest.values() if item["type"]=="application/x-dtbncx+xml"),None)
    entries=[]
    if toc_item:
        member=posixpath.normpath(posixpath.join(opf_dir,unquote(toc_item["href"])))
        root=xml_member(archive,member); base_dir=posixpath.dirname(member)
        nav_map=next((x for x in root.iter() if local(x.tag)=="navMap"),None)
        def walk_ncx(node,depth,path):
            nav_label=next((x for x in node if local(x.tag)=="navLabel"),None)
            label=""
            if nav_label is not None:
                label="".join((x.text or "") for x in nav_label.iter() if local(x.tag)=="text").strip()
            content=next((x for x in node if local(x.tag)=="content"),None)
            href=_toc_href(base_dir,content.attrib.get("src","") if content is not None else "",opf_dir)
            children=[x for x in node if local(x.tag)=="navPoint"]
            next_path=path+([label] if label else [])
            entries.append({"order":len(entries)+1,"label":label,"source_href":href,"depth":depth,"path":next_path,"has_children":bool(children)})
            for child in children: walk_ncx(child,depth+1,next_path)
        if nav_map is not None:
            for node in nav_map:
                if local(node.tag)=="navPoint": walk_ncx(node,0,[])
            return entries
    nav_item=next((item for item in manifest.values() if "nav" in item["properties"].split()),None)
    if not nav_item: return entries
    member=posixpath.normpath(posixpath.join(opf_dir,unquote(nav_item["href"])))
    root=xml_member(archive,member); base_dir=posixpath.dirname(member)
    nav=next((x for x in root.iter() if local(x.tag)=="nav" and (x.attrib.get("{http://www.idpf.org/2007/ops}type")=="toc" or x.attrib.get("role")=="doc-toc")),None)
    def walk_html(li,depth,path):
        label_node=next((x for x in li if local(x.tag) in {"a","span"}),None)
        label="".join(label_node.itertext()).strip() if label_node is not None else ""
        href=_toc_href(base_dir,label_node.attrib.get("href","") if label_node is not None else "",opf_dir)
        ol=next((x for x in li if local(x.tag)=="ol"),None); children=[x for x in ol] if ol is not None else []
        next_path=path+([label] if label else [])
        entries.append({"order":len(entries)+1,"label":label,"source_href":href,"depth":depth,"path":next_path,"has_children":bool(children)})
        for child in children:
            if local(child.tag)=="li": walk_html(child,depth+1,next_path)
    if nav is not None:
        ol=next((x for x in nav.iter() if local(x.tag)=="ol"),None)
        for li in list(ol or []):
            if local(li.tag)=="li": walk_html(li,0,[])
    return entries

def enrich_manifest(source,manifest_path):
    with zipfile.ZipFile(source) as archive:
        container=xml_member(archive,"META-INF/container.xml")
        rootfile=next((x.attrib.get("full-path","") for x in container.iter() if local(x.tag)=="rootfile"),"")
        opf=xml_member(archive,rootfile); opf_dir=posixpath.dirname(rootfile); manifest={}
        for x in opf.iter():
            if local(x.tag)=="item" and x.attrib.get("id"): manifest[x.attrib["id"]]={"href":x.attrib.get("href",""),"type":x.attrib.get("media-type",""),"properties":x.attrib.get("properties","")}
        toc=read_toc(archive,opf,opf_dir,manifest)
    data=json.loads(manifest_path.read_text(encoding="utf-8")); data["toc"]=toc
    temp=manifest_path.with_suffix(manifest_path.suffix+".tmp")
    temp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"); os.replace(temp,manifest_path)
    return data

def extract_epub(source,output,converted_from=None):
    if output.exists(): raise EbookError(f"输出目录已存在：{output}")
    output.mkdir(parents=True); chapters_dir=output/"chapters"; chapters_dir.mkdir()
    try: archive=zipfile.ZipFile(source)
    except Exception as exc: raise EbookError("文件不是可读取的 EPUB。") from exc
    with archive:
        container=xml_member(archive,"META-INF/container.xml")
        rootfile=next((x.attrib.get("full-path","") for x in container.iter() if local(x.tag)=="rootfile"),"")
        if not rootfile: raise EbookError("EPUB 缺少 OPF 包信息。")
        opf=xml_member(archive,rootfile); opf_dir=posixpath.dirname(rootfile)
        manifest={}
        for x in opf.iter():
            if local(x.tag)=="item" and x.attrib.get("id"): manifest[x.attrib["id"]]={"href":x.attrib.get("href",""),"type":x.attrib.get("media-type",""),"properties":x.attrib.get("properties","")}
        spine=[x.attrib.get("idref","") for x in opf.iter() if local(x.tag)=="itemref" and x.attrib.get("linear","yes")!="no"]
        toc=read_toc(archive,opf,opf_dir,manifest)
        records=[]
        for position,item_id in enumerate(spine,start=1):
            item=manifest.get(item_id)
            if not item or item["type"] not in {"application/xhtml+xml","text/html"} or "nav" in item["properties"].split(): continue
            href=unquote(item["href"].split("#",1)[0]); member=posixpath.normpath(posixpath.join(opf_dir,href))
            parser=TextExtractor(); parser.feed(text_member(archive,member)); text=parser.text()
            if not text.strip(): continue
            number=len(records)+1; title=parser.title or Path(href).stem or f"第 {number} 节"; filename=f"chapter-{number:04d}.txt"
            (chapters_dir/filename).write_text(text,encoding="utf-8")
            records.append({"chapter_number":number,"title":title,"source_locator":f"spine {position} · {href}","source_href":href,"spine_position":position,"output_file":f"chapters/{filename}","character_count":len(text)})
        result={"schema_version":2,"source_file":str(source.resolve()),"source_format":"azw3-converted-epub" if converted_from else "epub","converted_from":str(converted_from.resolve()) if converted_from else None,"opf_path":rootfile,"metadata":{"title":meta(opf,"title"),"creator":meta(opf,"creator"),"language":meta(opf,"language")},"toc":toc,"extracted_chapter_count":len(records),"chapters":records}
        (output/"manifest.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        return result

class ImageFinder(HTMLParser):
    """Images in reading order: <img src>, and SVG <image href/xlink:href> used for full-page illustrations."""
    def __init__(self): super().__init__(convert_charrefs=True); self.found=[]
    def handle_starttag(self, tag, attrs):
        tag=tag.lower().rsplit(":",1)[-1]; a={k.lower():v for k,v in attrs}
        if tag=="img" and a.get("src"): self.found.append((a["src"],a.get("alt") or ""))
        elif tag=="image":
            ref=a.get("xlink:href") or a.get("href")
            if ref: self.found.append((ref,""))
    handle_startendtag=handle_starttag

IMAGE_TYPES={".jpg",".jpeg",".png",".gif",".webp",".svg",".bmp",".avif"}
def extract_images(source,output):
    """Copy the illustrations of an EPUB into output/files and write output/index.json keyed by chapter href."""
    output.mkdir(parents=True,exist_ok=True); files=output/"files"
    try: archive=zipfile.ZipFile(source)
    except Exception as exc: raise EbookError("文件不是可读取的 EPUB。") from exc
    with archive:
        names=set(archive.namelist())
        container=xml_member(archive,"META-INF/container.xml")
        rootfile=next((x.attrib.get("full-path","") for x in container.iter() if local(x.tag)=="rootfile"),"")
        opf=xml_member(archive,rootfile); opf_dir=posixpath.dirname(rootfile)
        manifest={}
        for x in opf.iter():
            if local(x.tag)=="item" and x.attrib.get("id"): manifest[x.attrib["id"]]={"href":x.attrib.get("href",""),"type":x.attrib.get("media-type",""),"properties":x.attrib.get("properties","")}
        def copy(member):
            if member not in names or Path(member).suffix.lower() not in IMAGE_TYPES: return None
            target=(files/member).resolve()
            if files.resolve() not in target.parents: return None
            if not target.exists(): target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(archive.read(member))
            return member
        chapters={}
        for item in manifest.values():
            if item["type"] not in {"application/xhtml+xml","text/html"}: continue
            href=unquote(item["href"].split("#",1)[0]); member=posixpath.normpath(posixpath.join(opf_dir,href))
            if member not in names: continue
            finder=ImageFinder(); finder.feed(text_member(archive,member))
            images=[]
            for ref,alt in finder.found:
                if re.match(r"^[a-z]+:",ref,re.I): continue
                path=copy(posixpath.normpath(posixpath.join(posixpath.dirname(member),unquote(ref.split("#",1)[0]))))
                if path: images.append({"path":path,"alt":alt})
            if images: chapters[href]=images
        cover_id=next((x.attrib.get("content") for x in opf.iter() if local(x.tag)=="meta" and x.attrib.get("name")=="cover"),None)
        cover_item=manifest.get(cover_id) or next((i for i in manifest.values() if "cover-image" in i["properties"].split()),None)
        cover=copy(posixpath.normpath(posixpath.join(opf_dir,unquote(cover_item["href"])))) if cover_item else None
    result={"version":1,"chapters":chapters,"cover":cover}
    (output/"index.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    return result

def main():
    p=argparse.ArgumentParser(); p.add_argument("source"); p.add_argument("--output"); p.add_argument("--ebook-convert"); p.add_argument("--enrich-manifest"); p.add_argument("--images"); a=p.parse_args()
    source=Path(a.source).resolve(); output=Path(a.output).resolve() if a.output else None
    try:
        if a.images:
            result=extract_images(source,Path(a.images).resolve()); print(json.dumps({"chapters":len(result["chapters"]),"cover":bool(result["cover"])},ensure_ascii=False)); return
        if a.enrich_manifest:
            result=enrich_manifest(source,Path(a.enrich_manifest).resolve()); print(json.dumps({"manifest":a.enrich_manifest,"toc_entries":len(result.get("toc",[]))},ensure_ascii=False)); return
        if not a.output: raise EbookError("必须指定输出目录。")
        if source.suffix.lower()==".epub": result=extract_epub(source,output)
        elif source.suffix.lower()==".azw3":
            converter=a.ebook_convert or shutil.which("ebook-convert")
            if not converter: raise EbookError("AZW3 需要 Calibre ebook-convert，且仅支持无 DRM 文件。")
            output.parent.mkdir(parents=True,exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="azw3-",dir=output.parent) as temp:
                calibre_root=output.parent/"calibre-runtime"; config_dir=calibre_root/"config"; cache_dir=calibre_root/"cache"
                config_dir.mkdir(parents=True,exist_ok=True); cache_dir.mkdir(parents=True,exist_ok=True)
                env=os.environ.copy(); env["CALIBRE_CONFIG_DIRECTORY"]=str(config_dir); env["CALIBRE_CACHE_DIRECTORY"]=str(cache_dir); env["PYTHONUTF8"]="1"; env["PYTHONIOENCODING"]="utf-8"
                converted=Path(temp)/"converted.epub"; proc=subprocess.run([converter,str(source),str(converted)],capture_output=True,text=True,encoding="utf-8",errors="replace",env=env)
                diagnostic=(proc.stdout+"\n"+proc.stderr).strip()
                if proc.returncode or not converted.exists():
                    if "drm" in diagnostic.lower() or "encrypt" in diagnostic.lower(): raise EbookError("AZW3 带有 DRM 或加密，无法处理。")
                    raise EbookError("Calibre 转换失败："+diagnostic[-1000:])
                result=extract_epub(converted,output,source); shutil.copy2(converted,output/"converted-source.epub")
        else: raise EbookError("仅支持 EPUB 或 AZW3。")
    except EbookError as exc: p.exit(2, f"电子书提取失败：{exc}\n")
    print(json.dumps({"output":str(output),"chapters":result["extracted_chapter_count"]},ensure_ascii=False))
if __name__=="__main__": main()
