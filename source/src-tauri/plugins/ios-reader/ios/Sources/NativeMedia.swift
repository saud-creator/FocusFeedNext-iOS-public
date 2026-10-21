import UIKit
import AVKit
import ImageIO

struct NativeMediaItem: Decodable {
    let url: String
    let kind: String
    let alt: String?
}
struct NativeMediaArgs: Decodable {
    let revision: UInt64?
    let items: [NativeMediaItem]
    let index: Int
    let position: Double?
    let playing: Bool?
    let speed: Double?
    let muted: Bool?
    let loop: Bool?
    let retryLabel: String?
    let locale: String?
}

/// Audio session IPC must not block UIKit. Serial leases also prevent a late
/// dismissal from deactivating the next video's session. Keep the iOS 16 API.
private final class NativePlaybackAudio {
    static let shared=NativePlaybackAudio()
    private let queue=DispatchQueue(label:"com.focusfeed.next.playback-audio",qos:.userInitiated)
    private var owner:UUID?
    func activate(owner:UUID,ready:@escaping ()->Void) {
        queue.async {
            self.owner=owner
            let session=AVAudioSession.sharedInstance()
            try? session.setCategory(.playback,mode:.moviePlayback)
            try? session.setActive(true)
            DispatchQueue.main.async(execute:ready)
        }
    }
    func deactivate(owner:UUID) {
        queue.async {
            guard self.owner == owner else {return}
            self.owner=nil
            try? AVAudioSession.sharedInstance().setActive(false,options:.notifyOthersOnDeactivation)
        }
    }
}

/// One owner and one completion for all native media. URLs have already been
/// resolved against the current account's media registrations by Rust.
final class NativeMediaPresenter {
    private var order=PresentationOrder()
    private var controller: UIViewController?
    private var presentationID: UUID?
    var isPresented:Bool {controller != nil}
    private var completion: (([String:Any])->Void)?
    func present(_ args: NativeMediaArgs, from root: UIViewController, done: @escaping ([String:Any])->Void) -> Bool {
        guard order.accept(args.revision) else {done(["index":args.index,"position":args.position ?? 0,"playing":false]);return true}
        guard controller == nil, args.items.indices.contains(args.index), !args.items.isEmpty else { return false }
        let id=UUID();presentationID=id
        completion = done
        let finish: ([String:Any])->Void = { [weak self] result in
            guard let self = self, self.presentationID == id, let reply = self.completion else { return }
            self.presentationID=nil;self.completion = nil; self.controller = nil; reply(result)
        }
        if args.items[args.index].kind == "video" {
            guard let url = URL(string:args.items[args.index].url) else { presentationID=nil;completion = nil;return false }
            let video = NativeVideoController()
            let player = AVPlayer(url:url)
            video.player = player;video.modalPresentationStyle = .fullScreen
            player.isMuted = args.muted ?? false
            video.finished = { position,playing in finish(["index":args.index,"position":position,"playing":playing]) }
            video.shouldLoop = args.loop ?? false
            controller = video
            NativePlaybackAudio.shared.activate(owner:video.audioID) { [weak self,weak video] in
                guard let self=self,let video=video,self.presentationID == id,self.controller === video else {return}
                guard UIApplication.shared.applicationState == .active else {
                    NativePlaybackAudio.shared.deactivate(owner:video.audioID)
                    finish(["index":args.index,"position":args.position ?? 0,"playing":false])
                    return
                }
                root.present(video,animated:true) {
                    player.seek(to:CMTime(seconds:max(0,args.position ?? 0),preferredTimescale:600),toleranceBefore:.zero,toleranceAfter:.zero) { _ in
                        DispatchQueue.main.async {
                            if UIApplication.shared.applicationState == .active && video.presentingViewController != nil && !video.isBeingDismissed && (args.playing ?? true) { player.playImmediately(atRate:Float(args.speed ?? 1)) }
                        }
                    }
                }
            }
        } else {
            let photos = NativePhotoPager(items:args.items,index:args.index,retryLabel:args.retryLabel ?? "Retry image",locale:args.locale ?? "en")
            photos.finished = { index in finish(["index":index,"position":0,"playing":false]) }
            let navigation = UINavigationController(rootViewController:photos)
            navigation.modalPresentationStyle = .fullScreen
            navigation.overrideUserInterfaceStyle = .dark
            controller = navigation;root.present(navigation,animated:true)
        }
        return true
    }
    func dismiss(revision:UInt64?) {
        guard order.accept(revision) else {return}
        // Invalidate ownership before UIKit can deliver a dismissal callback.
        // A previous viewer must never settle a newer presentation's reply.
        let previous=controller;let reply=completion
        presentationID=nil;completion=nil;controller=nil
        if let video=previous as? NativeVideoController {
            video.player?.pause();NativePlaybackAudio.shared.deactivate(owner:video.audioID)
        }
        previous?.dismiss(animated:false);reply?(["index":0,"position":0,"playing":false])
    }
    func pause() {(controller as? AVPlayerViewController)?.player?.pause()}
}

private final class NativeVideoController: AVPlayerViewController {
    let audioID=UUID()
    var finished: ((Double,Bool)->Void)?
    var shouldLoop = false
    private var endObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var wasPlaying = false
    override func viewWillDisappear(_ animated:Bool) {wasPlaying=(player?.rate ?? 0)>0;super.viewWillDisappear(animated)}
    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier="native-video-loading"
        statusObservation=player?.currentItem?.observe(\.status,options:[.initial,.new]) { [weak self] item,_ in
            DispatchQueue.main.async {
                self?.view.accessibilityIdentifier=item.status == .readyToPlay ? "native-video-ready" : item.status == .failed ? "native-video-failed" : "native-video-loading"
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName:.AVPlayerItemDidPlayToEndTime,object:player?.currentItem,queue:.main) { [weak self] _ in
            guard let self = self,self.shouldLoop else { return }
            self.player?.seek(to:.zero);self.player?.play()
        }
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || presentingViewController == nil else { return }
        let time = player?.currentTime().seconds ?? 0
        let playing = wasPlaying || (player?.rate ?? 0) > 0
        player?.pause();player?.replaceCurrentItem(with:nil)
        NativePlaybackAudio.shared.deactivate(owner:audioID)
        let done=finished;finished=nil;done?(time.isFinite ? time : 0,playing)
    }
    deinit { if let observer=endObserver {NotificationCenter.default.removeObserver(observer)} }
}

private final class NativePhotoPager: UIPageViewController, UIPageViewControllerDataSource, UIPageViewControllerDelegate, UIGestureRecognizerDelegate {
    let items:[NativeMediaItem]
    var index:Int
    var finished:((Int)->Void)?
    private let cache=NSCache<NSURL,UIImage>()
    private let session:URLSession
    let retryLabel:String
    let closeLabel:String
    let numberFormatter=NumberFormatter()
    init(items:[NativeMediaItem],index:Int,retryLabel:String,locale:String) {
        self.items=items;self.index=index
        self.retryLabel=retryLabel
        closeLabel=locale == "ar" ? "إغلاق" : "Close"
        numberFormatter.locale=Locale(identifier:locale)
        let config=URLSessionConfiguration.ephemeral;config.urlCache=nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData;config.timeoutIntervalForRequest=20;config.timeoutIntervalForResource=30
        session=URLSession(configuration:config)
        super.init(transitionStyle:.scroll,navigationOrientation:.horizontal)
        cache.totalCostLimit=32*1024*1024
    }
    required init?(coder:NSCoder) { fatalError("init(coder:) is unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad();view.backgroundColor = .black;dataSource=self;delegate=self
        let closeItem=UIBarButtonItem(barButtonSystemItem:.close,target:self,action:#selector(close))
        closeItem.accessibilityIdentifier="native-photo-close"
        closeItem.accessibilityLabel=closeLabel
        navigationItem.rightBarButtonItem=closeItem
        setViewControllers([page(index)],direction:.forward,animated:false);updateTitle()
        let swipe=UIPanGestureRecognizer(target:self,action:#selector(pan(_:)));swipe.delegate=self;view.addGestureRecognizer(swipe)
    }
    private func page(_ number:Int)->NativePhotoPage { NativePhotoPage(item:items[number],index:number,session:session,cache:cache,retryLabel:retryLabel) }
    private func updateTitle() { title="\(numberFormatter.string(from:NSNumber(value:index+1)) ?? "") / \(numberFormatter.string(from:NSNumber(value:items.count)) ?? "")" }
    @objc private func close() { dismiss(animated:true) }
    @objc private func pan(_ gesture:UIPanGestureRecognizer) { if gesture.state == .ended && abs(gesture.translation(in:view).y)>100 { close() } }
    func gestureRecognizerShouldBegin(_ gestureRecognizer:UIGestureRecognizer)->Bool {
        guard let pan=gestureRecognizer as? UIPanGestureRecognizer else {return true}
        let velocity=pan.velocity(in:view)
        return abs(velocity.y)>abs(velocity.x) && ((viewControllers?.first as? NativePhotoPage)?.zoomScale ?? 1)<=1.01
    }
    func pageViewController(_ pageViewController:UIPageViewController,viewControllerBefore viewController:UIViewController)->UIViewController? {
        guard let current=viewController as? NativePhotoPage,current.index>0 else{return nil};return page(current.index-1)
    }
    func pageViewController(_ pageViewController:UIPageViewController,viewControllerAfter viewController:UIViewController)->UIViewController? {
        guard let current=viewController as? NativePhotoPage,current.index+1<items.count else{return nil};return page(current.index+1)
    }
    func pageViewController(_ pageViewController:UIPageViewController,didFinishAnimating finished:Bool,previousViewControllers:[UIViewController],transitionCompleted completed:Bool) {
        if completed,let current=viewControllers?.first as? NativePhotoPage {index=current.index;updateTitle()}
    }
    override func viewDidDisappear(_ animated:Bool) {
        super.viewDidDisappear(animated)
        if navigationController?.isBeingDismissed == true || navigationController?.presentingViewController == nil {
            session.invalidateAndCancel();cache.removeAllObjects();let done=finished;finished=nil;done?(index)
        }
    }
    override func didReceiveMemoryWarning() {super.didReceiveMemoryWarning();cache.removeAllObjects()}
}

private final class NativePhotoPage:UIViewController,UIScrollViewDelegate {
    let index:Int
    let item:NativeMediaItem
    let session:URLSession
    let cache:NSCache<NSURL,UIImage>
    let retryLabel:String
    private let scroll=UIScrollView()
    private let image=UIImageView()
    private var request:URLSessionDownloadTask?
    private var requestID=UUID()
    private let retry=UIButton(type:.system)
    private let activity=UIActivityIndicatorView(style:.large)
    var zoomScale:CGFloat {scroll.zoomScale}
    init(item:NativeMediaItem,index:Int,session:URLSession,cache:NSCache<NSURL,UIImage>,retryLabel:String) {
        self.item=item;self.index=index;self.session=session;self.cache=cache;self.retryLabel=retryLabel;super.init(nibName:nil,bundle:nil)
    }
    required init?(coder:NSCoder) {fatalError("init(coder:) is unavailable")}
    override func viewDidLoad() {
        super.viewDidLoad();view.backgroundColor = .black
        scroll.delegate=self;scroll.minimumZoomScale=1;scroll.maximumZoomScale=4;scroll.translatesAutoresizingMaskIntoConstraints=false
        image.contentMode = .scaleAspectFit;image.isAccessibilityElement=true;image.accessibilityLabel=item.alt;image.accessibilityIdentifier="native-photo-loading"
        view.addSubview(scroll);scroll.addSubview(image)
        NSLayoutConstraint.activate([scroll.leadingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.leadingAnchor),scroll.trailingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.trailingAnchor),scroll.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor),scroll.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor)])
        retry.setTitle(retryLabel,for:.normal);retry.accessibilityIdentifier="native-photo-retry"
        retry.translatesAutoresizingMaskIntoConstraints=false;retry.addTarget(self,action:#selector(loadImage),for:.touchUpInside);retry.isHidden=true;view.addSubview(retry)
        NSLayoutConstraint.activate([retry.centerXAnchor.constraint(equalTo:view.safeAreaLayoutGuide.centerXAnchor),retry.centerYAnchor.constraint(equalTo:view.safeAreaLayoutGuide.centerYAnchor),retry.heightAnchor.constraint(greaterThanOrEqualToConstant:44)])
        activity.translatesAutoresizingMaskIntoConstraints=false;activity.color = .white;activity.hidesWhenStopped=true;view.addSubview(activity)
        NSLayoutConstraint.activate([activity.centerXAnchor.constraint(equalTo:view.safeAreaLayoutGuide.centerXAnchor),activity.centerYAnchor.constraint(equalTo:view.safeAreaLayoutGuide.centerYAnchor)])
        let tap=UITapGestureRecognizer(target:self,action:#selector(doubleTap(_:)));tap.numberOfTapsRequired=2;scroll.addGestureRecognizer(tap)
        loadImage()
    }
    override func viewDidLayoutSubviews() {super.viewDidLayoutSubviews();if scroll.zoomScale==1 {image.frame=scroll.bounds;scroll.contentSize=scroll.bounds.size}}
    @objc private func doubleTap(_ tap:UITapGestureRecognizer) {
        if scroll.zoomScale>1 {scroll.setZoomScale(1,animated:true)} else {
            let point=tap.location(in:image);let size=CGSize(width:scroll.bounds.width/2.5,height:scroll.bounds.height/2.5)
            scroll.zoom(to:CGRect(x:point.x-size.width/2,y:point.y-size.height/2,width:size.width,height:size.height),animated:true)
        }
    }
    func viewForZooming(in scrollView:UIScrollView)->UIView? {image}
    @objc private func loadImage() {
        guard let url=URL(string:item.url) else{return}
        if let cached=cache.object(forKey:url as NSURL) {image.image=cached;image.accessibilityIdentifier="native-photo-image";retry.isHidden=true;activity.stopAnimating();return}
        request?.cancel();let id=UUID();requestID=id;retry.isHidden=true;activity.startAnimating();image.accessibilityIdentifier="native-photo-loading"
        // Download to a temporary file and downsample directly from it. A
        // large original never becomes an equally large in-memory Data value.
        request=session.downloadTask(with:url) { [weak self] file,response,error in
            var decoded:UIImage?
            if error==nil,let response=response as? HTTPURLResponse,(200...299).contains(response.statusCode),let file=file,
               let size=(try? file.resourceValues(forKeys:[.fileSizeKey]))?.fileSize,size<=32*1024*1024,
               let source=CGImageSourceCreateWithURL(file as CFURL,nil),let cg=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceShouldCacheImmediately:true,kCGImageSourceThumbnailMaxPixelSize:2048] as CFDictionary) {decoded=UIImage(cgImage:cg)}
            DispatchQueue.main.async {
                guard let self=self,self.requestID==id else{return}
                self.activity.stopAnimating()
                self.image.image=decoded;self.retry.isHidden=decoded != nil
                self.image.accessibilityIdentifier=decoded == nil ? "native-photo-failed" : "native-photo-image"
                if let decoded=decoded {self.cache.setObject(decoded,forKey:url as NSURL,cost:Int(decoded.size.width*decoded.size.height*4))}
            }
        };request?.resume()
    }
    deinit {request?.cancel()}
}
