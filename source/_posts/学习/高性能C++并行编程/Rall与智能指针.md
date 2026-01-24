---
title: "Rall与智能指针"
date: 2025-12-19 08:47:51
tags:
  - "C++"
  - "RAII"
  - "智能指针"
categories:
  - "学习"
  - "高性能C++并行编程"
thumbnail: /img/covers/cover4.jpg
---
# Rall与智能指针

帮我把这个整理一下“# RALL & 智能指针

在多进程编程中由于相互进程线程之间相互关系，首先最重要的就是互相访问对象时不会产生冲突。
RAII（Resource Acquisition Is Initialization，资源获取即初始化）是一种在 C++ 中常见的编程范式，主要用于管理资源（如动态内存、文件句柄、网络连接等）。其核心思想是将资源的生命周期绑定到对象的生命周期，通过对象的构造函数来获取资源，通过对象的析构函数来释放资源。这种方式避免了显式的资源管理，减少了资源泄漏的可能性。

RALL 通常应用于 内存管理（智能指针）；文件管理；互斥锁管理
智能指针：unique_ptr shared_ptr
## 进程和线程
进程都有自己独立的一块内存空间，一个进程可以有多个线程。一个进程只的线程能共享资源

## 多线形编程

### thread
基础线程
```c++
# include <thread>

void foo(args)// 自定义函数

int main(){//
    std::thread t(foo args) //创建了命名为t一个子线程
    std::thread::join() //  等待子线程运行完才会释放
    std::thread::detach() //不用等待就能直接释放（会产生风险）
    t.joinable // std::thread::joinable

    // lambda 
    std::thread t([](int a, int b ){
        std::cout<< a << " "<< b << "\n";
    },1,2);// 1 "" b



}
```
参数传递 智能指针
``` c++
# include<iostream>
# include<thread>
# include<memory>

void foo_unique(std::unique_per *p){};
void foo_shared(std::shared_per *p){};

int main(){
    // 采用智能指针的好处，就是能自动detach()
    std::unique_ptr<int> ptr_1 = std::make_unique<int>(520);//注意独占所有权
    std::shared_ptr<int> ptr_2 = std::make_shared<int>(520);

    std::thread t_unique(foo_unique, std::move(ptr_1));
    t_unique.join();

    std::thrad t_shared(foo_shared, ptr_2);
    t_shared.join();

}

```
线程所有权管理 使用std::move()
``` c++
# include<iostream>
# include<thread>

void foo_1(){};
void foo_2(){};

int main(){
    std::thread t_1(foo_1);
    std::thread t_2(std::move(t_1));
    t_1 = std::thread(foo_2);

    std::cout<< t_1.joinable();
    std::cout<< t_2.joinable();

    std::thread t_3;
    t3 = std::move(t_2);

    t1.join();
    // t2.join(); t2 已经通过std::move 将进程转移给了t3，t2里面为null t2.jion没有意义
    t3.join();
    
    return 0;
}
```

std::thrad scoped_thread RALL 自动join()&detach()[需要在思考一下]
```c++
# include<iostream>
# include<thread>

class scoped_thread{
    std::thread t;
public:
    explicit scoped_thread(std::thread t_):t(std::move(t_)){
        if(!t.joinable()){
            throw std::logic_error("thread is unjoinable.");
        }
    }
    ~scoped_thread(){
        if(t.joinable()){
            t.join();
        }
    }
    scoped_thread(scoped_thread const&) = delete;
    scoped_thread& operator=(scoped_thread const&) = dalete;
}
void foo(int cnt){};

int main(){
    scoped_thread st(std::thread(foo, 100));
    return 0;
}
```

CPU核心 & 支持线程数
```c++
# include<iostream>
# include<thread>

void foo(int a){
    std::count<< std::this_thread::get_id();
};

int main(){
    size_t n = std::thread::hardware_concurrency()//获取核心数
    
    std::vector<std::thread> pv(10);

    for(auto t :pv) t = std::thread(foo);
    for(auto t : pv){
        if(t.joinable()) t.join();
    }

    return 0;
}
```

### 互斥操作
互斥锁基于一种互斥的原则，即 同一时刻 只允许 一个线程访问被保护的资源。当一个线程获取互斥锁，其他试图访问共享资源的线程会被 阻塞，直到当前这个获取锁的线程 释放锁。确保避免了数据竞争的问题。
std::mutex
```c++
// 通过一个对列实现读入和读出，保证互相不冲突
# include<iostream>
# include<thread>
# include<mutex>
# include<vector>
# include<queue>

class Myclass{
    std::queue<int> msg_que;
    std::mutex mtx;
public:
    void in_msg_que(int num){
        for(int i =0 i<num;i++){
            mtx.lock();
            msg_que.push(i);
            mtx.unlock();
        }
    }
    void out_msg_que(int num){
        for(int i=0;i<num;i++){
            int commad;
            if(pop_command(command)){

            }else{

            }
        }
    }
    bool pop_command(int &commad){
        mtx.lock();
        if(msg_que.empty()){
            mtx.unlock();
            return false;
        }

        command = msg_que.front();
        msg_que.pop();
        return true;
    }
};
int main(){
    MyCLass obj_a;
    std::thread out_msg_t (&Myclass::out_msg_que, &obj_a,7);
    std::thread in_msg_t(&Myclass::in_msg_que, &obj_a,5);
    out_msg_t.join();
    in_msg_t.join();
    return 0;
}
```

std::lock_guard 作用逾
```c++
# include<iostream>
# include<thread>
# include<mutex>

std::mutex mtx;
int count;

void foo(int num){
    for(int i=0;i<num;i++){
        std::lock_guard<std::mutex> lck(mtx);// {}中自动加锁
        count++
    }
}
```

unique_lock lock_guard 升级版支持更多操作，但是带来更多的开销，简单的操作还是采用lock_guard

```c++
#include <iostream>
#include <thread>
#include <mutex>
#include <vector>
#include <queue>

class MyClass{
	std::queue<int> msg_que; // 存储用户命令的消息队列
	std::mutex mtx; // 互斥量
public:
	void in_msg_que(int num){
		for(int i = 0; i < num; i ++ ){
			std::cout << "in_msg_que() running, push data: " << i << "\n";
			// 使用 try_to_lock 参数，尝试加锁
			std::unique_lock<std::mutex> lck(mtx, std::try_to_lock);
			if(lck.owns_lock()){
				// 尝试后成功拿到了锁
				msg_que.push(i); 
			}else{
				// 没有成功拿到锁，直接返回
				std::cout << "in_msg_que() running, but cannot get lock: " << i << "\n";
			}
		}
	}

	void out_msg_que(int num){
		int command = 0;
		for(int i = 0; i < num; i ++ ){
			if(pop_command(command)){
				// 消息队列不为空，处理取出的指令
				std::cout << "out_msg_que() running, command is: " << command << "\n";
			}else{
				// 消息队列为空
				std::cout << "out_msg_que() running, queue is empty: " << i << "\n";
			}
		}
	}

	bool pop_command(int& command){
		std::unique_lock<std::mutex> lck(mtx); // 使用 unique_lock 实现自动加锁、解锁
		if(msg_que.empty()){
            // 如果为空，直接返回 false
            return false; 
        }
        command = msg_que.front(); // 从队首取出指令
		msg_que.pop();
		return true;
	}
};

int main(){
	MyClass obj;
	std::thread out_msg_t(&MyClass::out_msg_que, &obj, 10000); 
	std::thread in_msg_t(&MyClass::in_msg_que, &obj, 10000);

	out_msg_t.join();
	in_msg_t.join();

	return 0;
}

```
std::defer_lock: 延迟加锁
std::adopt_lock:已经拥有了互斥量的锁,管理转移给 std::unique_lock 对象
std::try_to_lock:对象并尝试非阻塞地锁定互斥量。如果互斥量当前不可用，它不会阻塞线程，而是直接返回。
lck.owns_lock()是否已经有锁

std::timed_mutex 基本概念 
std::timed_mutex::try_lock_for()
std::timed_mutex::try_lock_until()
```c++
# include<iostream>
# include<thread>
# include<mutex>
# include<vector>
# include<chrono>

std::timed_mutex t_mtx;
int count;

void foo(int id){
    std::chrono::milliseconds timeout(100);
    auto start = std::chrono::steady_clock::now();
    if(t_mtx.try_lock_for(timeout)){
        auto end = std::chrono::steady_clock::now();
        std::chrono::duration<double, std::milli> dura = end -start;
        std::cout << "thread " << id << ": Successfully get the lock. ";
        std::cout << "waiting duration = " << dura.count() << "ms." << "\n";

        // 以下模拟一些互斥操作
        std::this_thread::sleep_for(std::chrono::milliseconds(15));
        count ++ ;     // 对共享数据变量进行访问和修改
        t_mtx.unlock();  // 解锁
    }
}
int main(){
    std::vector<std::thread> threads(10);

    for(int i =0;i<threads.size();i++)

    return 0;
}

```

std::recursive_mutex 提供了重复（递归）加锁的特性
``` c++
# include<iostream>
# include<thread>
# include<mutex>
# include<vector>

std::mutex r_mtx;
int count;

void foo(int k){
    if(k == 0) return ;
    r_mtx.lock();
    count++;
    dfs(k-1);
    r_mtx.unlock();
}
int main(){
    std::vector<std::thread> threads(3);
    for(auto t : threads) t = std::thread(dfs,5);
    for(auto t: threads) t.join();
    return 0;
}
```
std::shared_mutex 在 C++ 17 被正式引入，是一种互斥量（mutex）类型，包含在 <shared_mutex> 头文件中。
std::shared_mutex 提供了两种不同的锁机制，其可以作为 共享锁 使用，也可以作为 独占锁 使用。
共享锁 允许多个线程同时对共享数据进行访问，一般用于多个线程读取共享资源的情况。在这种机制下，多个线程可以同时获得互斥量的锁（共享锁），只要对数据的操作仅限于读取。共享锁 可以提高多线程读取数据场景下的并发性能。
独占锁 只允许单个线程在同一时刻对共享数据进行操作，一般用于多线程对共享数据进行修改等操作的情况。独占锁 被一个线程占用时，其他线程就无法获得这个锁，直到这个独占锁被释放，以确保数据的一致性。
共享锁和独占锁感觉就像是在锁中在分出两个大类，比如先完成a任务才能完成b任务之类的
读并发与写阻塞

当有多个读线程获得共享锁时，这些读线程可以并发地对共享资源进行读取操作。此时如果有写线程尝试获取独占锁，这个写线程会被阻塞。

阻塞会一直持续，直到所有当前持有共享锁的读线程都释放了共享锁。

写独占与读阻塞

当一个写线程占有独占锁时，新的读线程尝试获取共享锁会被阻塞。独占锁的优先级高于共享锁。

这种设计是为了防止写操作饥饿（write - starvation）的情况。如果读线程不断地获取共享锁，而写线程一直无法获取独占锁来执行写入操作，这会导致数据不能及时更新。
``` c++
#include <iostream>
#include <thread>
#include <shared_mutex>
#include <chrono>
#include <vector>

class Reader_Writer{
    std::shared_mutex s_mtx;  // 互斥量
    int val = 0;              // 共享数据
public:
    // 读操作
    void read_data(int id){
        std::shared_lock<std::shared_mutex> lck(s_mtx); // 共享锁
        std::cout << "Reader " << id << " reads the value = " << val << "\n";
    }
    // 读者，进行 100 次读操作
    void reader(int id){
        for(int i = 0; i < 100; i ++ ){
            read_data(id);
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
    // 写操作
    void write_data(int id){
        std::unique_lock<std::shared_mutex> lck(s_mtx); // 独占锁
        val ++ ;
        std::cout << "Writer " << id << " writes the value = " << val << "\n";
    }
    // 写者，进行 10 次写操作
    void writer(int id){
        for(int i = 0; i < 10; i ++ ){
            write_data(id);
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        }
    }
};

int main(){
    Reader_Writer obj;
    // 创建 10 个读者线程和 2 个写者线程
    std::vector<std::thread> readers(10);
    for(size_t i = 0; i < readers.size(); i ++ ){
        readers[i] = std::thread(&Reader_Writer::reader, &obj, i);
    }
    std::vector<std::thread> writers(2);
    for(size_t i = 0; i < writers.size(); i ++ ){
        writers[i] = std::thread(&Reader_Writer::writer, &obj, i);
    }

    for(auto& reader : readers) reader.join();
    for(auto& writer : writers) writer.join();

    return 0;
}
```
std::call_once这个函数模板主要作用是 保证一个函数（可调用对象）在多线程环境下只被调用一次。

```c++
# include<iostream>
# include<thread>
# include<mutex>
# include<vector>

std::mutex mtx;
std::once_flag flag;
int val;

void init(){
    std::call_one(flag,[](){
        val = 1 // 初始化
    });
}
```
生产者-消费者问题
std::condition_variable主要用于 线程间的同步。
std::condition_variable::wait() 函数是 std::condition_variable 中的一个关键成员函数，主要用于让线程 等待某个条件成立，通常配合互斥量（mutex）进和 std::unique_lock 使用，以实现线程的同步。
使用 wait() 函数时，只能搭配 std::unique_lock 互斥锁使用，不能使用 std::lock_guard。std::condition_variable::wait() 需要在等待期间自动释放互斥量，然后在被唤醒后重新获取互斥量。但是 std::lock_guard 没有提供这样的功能。

std::condition_variable::notify_one() 主要用于当某个条件成立，通知 一个 处于阻塞状态下（等待该条件成立）的线程，进而唤醒这个线程。
notify_all()
```c++
# include<iostream>
# include<thread>
# include<mutex>
# include<atomic>
# include<condition_variable>
# include<queue>
# include<vector>
# include<chrono>

std::mutex mtx;
std::condition_variable cv;
std::queue<int> buffer;
const int BUFFER_SIZE = 10;
const int PRODUCER_NUM = 2;
const int CONSUMER_NUM = 5;
int produce_finished_count;

// 生产者函数
void producer(int id, int data_num){
    for(int i =0;i<data_num;i++){
        std::unique_lock<std::mutex> lck(mutx);
        while(buffer.size() >= BUFFER_SIZE){
            cv.wait(lck);
        }
        buffer.push(i);
        cv.notify_all();
    }
    {
        std::lock_guard<std::mutex> lck(mtx);
        produce_finished_count ++;
        if(produce_finished_count == PRODUCER_NUM){
            cv.notify_all();
        }
    }
}

void consumer(int id){
    while(true){
        std::unique_lock<std::mutex> lck(mtx);
        while(buffer.empty() && produce_finished_count < PRODUCER_NUM){
            cv.wait(lck);
        }
        while(buffer.empty() && produce_finished_count == PRODUCER_NUM) break;
        int data = buffer.front();
        buffer.pop();
        lck.unlok();
        cv.notify_all();
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

int main(){
    std::vector<std::thread> producers(PRODUCER_NUM);
    std::vector<std::thread> consumers(CONSUMER_NUM);
    for(size_t i =0;i<producers.size();i++){
        producers[i] = std::thread(producer,i+1,1000);
    }
    for(size_t i=0;i<consumers.size();i++){
        consumers[i] = std::thread(consumer,i+1,1000);
    }
    for(auto t: producers) t.join();
    for(auto t: consumers) t.join();

    return 0;
}

```
异步任务
std::async 是 C++ 11 引入的一个函数模板，用于异步地启动一个函数任务。它位于 <future>头文件中
``` c++
# include<iostream>
# include<future>

int foo(int a, int b){
    return a +b;
}

int main(){
    std::future<int> res = std::async(std::launch::async, foo, 1, 2); // std::async 创建异步任务， std::launch::async 异步执行策略（立刻执行）
    auto data = res.get(); // std::future::get()   异步任务返回值， 一个std::future 只能调用一次，调用完后res就会释放
    std::cout<< data << "\n";
    return 0
}
```
``` c++
//std::async 立即执行分析
# include<iostream>
# include<thread>
# include<future>
# include<chrono>

int foo(int a, int b){
    std::cout<< "foo(): thread id ="<< std::this_thread::get_id() << "\n";
    std::cout << "foo(): starts calculating the res..." << "\n";
    std::this_thread::sleep_for(std::chrono::seconds(4));
    std::cout << "foo(): ends calculating the res..." << "\n";
    return a + b;
}
int main(){
    std::cout << "main(): thread id = " << std::this_thread::get_id() << "\n";
    std::future<int> res = std::async(std::launch::async, foo, 3, 4);// std::launch

    // 主线程 main() 中同时可以做一些其他事情
    std::cout << "main(): starts doing somethine else..." << "\n";
    std::this_thread::sleep_for(std::chrono::seconds(2));
    std::cout << "main(): ends doing something else..." << "\n";
    
    auto data = res.get();// get() wait() 都能实现阻塞，但是区别是返不返回值
    std::cout << "finally get the res = " << data << "\n"; // 直到获取结果才会执行这一句
    std::cout << "Kirisame Marisa." << "\n"; 

    return 0;

}
```

``` c++
//延迟执行分析
#include <iostream>
#include <thread>
#include <future>
#include <chrono>

int foo(int a, int b){
    std::cout << "foo(): thread id = " << std::this_thread::get_id() << "\n";
    std::cout << "foo(): starts calculating the res..." << "\n";
    std::this_thread::sleep_for(std::chrono::seconds(4));
    std::cout << "foo(): ends calculating the res..." << "\n";
    return a + b;
}

int main(){
    std::cout << "main(): thread id = " << std::this_thread::get_id() << "\n";

    // 创建一个异步任务，std::launch::deferred 会延迟执行 foo()，直到某个调用 get() 或 wait()
    std::future<int> res = std::async(std::launch::deferred, foo, 3, 4);

    // 主线程 main() 中同时可以做一些其他事情
    std::cout << "main(): starts doing somethine else..." << "\n";
    std::this_thread::sleep_for(std::chrono::seconds(2));
    std::cout << "main(): ends doing something else..." << "\n";

    // (1) 在主线程中调用 get() 才开始执行 foo()，实际上是在主线程中执行，最后获取结果
    auto data = res.get();
    std::cout << "finally get the res = " << data << "\n"; // 直到获取结果才会执行这一句
    // (2) 在主线程中调用 get() 才开始执行 foo()，但最后不获取结果
    // res.wait(); 
    // (3) 如果前面不调用 get() 或 wait()，foo() 压根不会被执行，会直接输出这一句
    
    std::cout << "Kirisame Marisa." << "\n"; 

    return 0;
}
``` 
``` c++
#include <iostream>
#include <thread>
#include <chrono>
#include <future>

int foo(int a, int b){ 
    std::cout << "foo(): thread id = " << std::this_thread::get_id() << "\n";
    std::cout << "foo(): starts caculating the res..." << "\n";
    std::this_thread::sleep_for(std::chrono::seconds(2)); // foo() 需要执行大概 2 秒
    std::cout << "foo(): ends caculating the res..." << "\n";
    return a + b;
}

int main(){
    std::cout << "main(): thread id = " << std::this_thread::get_id() << "\n";

	// (1) 创建一个异步任务
	// (1.1) std::launch::async 会立即执行 foo()，wait_for() 可能超时，可能成功获取结果
    std::future<int> res = std::async(std::launch::async, foo, 3, 4);
    // (1.2) std::launch::deferred 会延迟执行 foo()，直到某个调用 get() 或 wait()，wait_for() 不起作用
    // std::future<int> res = std::async(std::launch::deferred, foo, 3, 4);
	// (1.3) 默认情况（std::launch::async | std::launch::deferred），则不确定为 (1.1) 还是 (1.2)
	// std::future<int> res = std::async(foo, 3, 4);

	auto get_data = [&](std::future<int>& res){
		auto data = res.get();
		std::cout << "finally get the res = " << data << "\n";
	};

	// (2) 枚举类型，判断 res 的状态
	// std::future_status status = res.wait_for(std::chrono::seconds(1)); // 等待 1 秒，超时
	std::future_status status = res.wait_for(std::chrono::seconds(3)); // 等待 3 秒，成功获取结果
	if(status == std::future_status::timeout){
		// (2.1) foo() 还未执行完成，超过等待时间，没有返回结果，超时
		std::cout << "WARNING: time out" << "\n";
	}else if(status == std::future_status::ready){
		// (2.2) foo() 在等待时间内执行完毕，可以获取结果（参数为 std::launch::async）
		std::cout << "successfully get result." << "\n";
		get_data(res);
	}else if(status == std::future_status::deferred){
		// (2.3) 参数为 std::launch::deferred 就会出现此情况 
		std::cout << "thread is deferred." << "\n";
		get_data(res);
	}

	return 0;
}
```
### 原子操作
原子操作通常用于多线程开发中，由于其特性使得其可以实现安全的多线程访问，并且不需要担心复杂的线程锁等

1.std::atomic<type>

2.std::atomic_flag
    1. 类似bool 常量，只有两种状态 ture&false
    2. test_and_set()// 将 std::atomic_flag 设置为 ture，但是返回值为设置前的状态
    3. clear() // ture -> false;
    4. amtoic_flag 自旋锁机制实现
```c++
# include<iostream>
# include<thread>
# include<atomic>
# include<vector>

class spinlock_mutex{
    std::atomic_flag flag;
public:
    spinlock_mutex():flag(ATOMIC_FLAG_INIT) {};
    void lock(){
        while(flag.test_and_set());// 通过test_and_set 返回的前状态进行检测1.ture就进入while循环等待，2.false跳出等待
    }
    void unlock(){
        flag.clear(); // 进行解锁将flag：true ->false;
    }
}

int count;
spinlock_mutex mtx;

void foo(){
    mtx.lock();
    count++;
    mtx.clear();
}
int main(){
    std::vector<std::thread> threads(10);
    for(auto t : threads) t = std::thread(foo);
    for(auto t : threads) t.join();
    return 0;
}
```

3. std::atomic
    1. std::atomic<int> atm(0) // = atm = 0
    2. load() // int val = atm.load()
    3. store() // operator= 重载
    4. exchange // 注意 atm.exchange(x) 返回的是改变成x前的值，而不是x

std::memory_order_relaxed 内存序
``` c++
# include<iostream>
# include<thread>
# include<atomic>
# include<chrono>

std::atomic<int> atm1(0), atm2(0);
int res1 = 0; res2 = 0;

void foo1(){
    res1 = atm2.load(std::memory_order_relaxed);
    atm1.store(1, std::memory_order_relaxed)
}

void foo2(){
    res2 = atm1.load(std::memory_order_relaxed);
    atm2.store(1,std::memory_order_relaxed)
}
int main(){
    std::thread t1(foo1)
    std::thread t2(foo2)

    t1.join();
    t2.join();
    // 因为内存序的问题会有多种res1，res2结果
}
```

std::memory_order_seq_cst 严格的内存顺序。它不仅保证原子操作的原子性，还保证所有使用
```c++
#include <atomic>
#include <thread>
#include <iostream>
#include <chrono>

std::atomic<int> atm1(0), atm2(0);
int res1 = 0, res2 = 0;

void foo1(){
    res1 = atm2.load(std::memory_order_seq_cst);
    amt1 = std::store(1, std::memory_order_seq_cst);
}
void foo2(){
    res2 = atm1.load(std::memory_order_seq_cst);
    amt2 = std::store(1, std::memory_order_seq_cst);
}

int main(){
    std::thread t1(foo1);
    std::thread t2(foo2);

    t1.join();
    t2.join();

    return 0;
}

```
## 总结
### 多种方法实现加速求和优化
std::mutex
```c++
# include<iostream>
# include<thread>
# include<mutex>
# include<vector>
# include<numeric>
# include<chrono>

const int NUM_THEEAD = 24;
long long arr_sum = 0;
std::mutex mtx;

void get_sum(const vector<int> &arr, int start, int end){
    long long cur_sum = 0;
    for(int i =start; i< end;i++) cur_sum += i;
    std::lock_guard(std::mutex) lck(mtx);
    arr_sum += cur_sum;
}

int main(){
    const int n = 1e9;
    std::vector<int> arr(n);
    std::iota(begin(arr), end(arr), 0 );
    auto start_time = std::chrono::high_resoultion_clock::now();

    const int step = n/NUM_THREAD;
    std::vector(std::thread) threads(NUM_THEAD);
    for(int i =0;i< NUM_THREAD; i++){
        int start = i*step;
        int end = (i == NUM_THREADS - 1)?n:(i+1)*step;
        threads[i] = std::threads(get_sum, std::ref(arr),start, end);
    }
    for(auto t:threads) t.join();

    return 0;
}
```

std::async 异步任务的方法
```c++
# include<iostream>
# include<thread>
# include<vector>
# include<meteric>
# include<chrono>

const int NUM_THEADS = 24;
long long arr_sum;

long long get_sum(cont std::vector<int> &arr, int start, int end){
    long long cur_sum = 0;
    for(int i = start;i<end;i++){
        cur_sum += arr[i];
    }
    return cur_sum;
}

int main(){
    const int num = 1e9;
    std::vector<int> arr(n);
    std::iota(begin(arr), end(arr),0);

    const int step = n/NUM_THREADS;
    std::vector<std::future<long long>> futures(NUM_THREADS);
    for(int i =0;i<NUM_THREADS;i++){
        int start = i * step;
        int end = (i == NUM_THREADS -1)? n; (i+1)*step;
        futures[i] == std::sanyc(get_sum, std::ref(arr),start, end);
    }
    for(auto t: futures){
        arr_sum += res.get();
    }   
    return 0;
}
```
std::promise 异步任务的方法
```c++
#include <iostream>
#include <thread>
#include <future>
#include <vector>
#include <numeric>
#include <chrono>

const int NUM_THREADS = 24;
long long arr_sum; // 共享数据变量，数组之和

void get_sum(const std::vector<int>& arr, int start, int end, 
             std::promise<long long>& pro){ // 传入 promise
    long long cur_sum = 0;
    for(size_t i = start; i < end; i ++ ){
        cur_sum += arr[i];
    }
    pro.set_value(cur_sum); // 设置数组子段结果的值
}

int main(){
    // 数组数据输入
    const int n = 1e9;
    std::vector<int> arr(n);
    std::iota(begin(arr), end(arr), 0);

    // 计算起始时间点
    auto start_time = std::chrono::high_resolution_clock::now();

    // 创建多个异步任务
    const int step = n / NUM_THREADS; // 每个线程计算的块大小
    std::vector<std::promise<long long>> promises(NUM_THREADS);
    std::vector<std::future<long long>> futures(NUM_THREADS);
    std::vector<std::thread> threads(NUM_THREADS);
    for(int i = 0; i < NUM_THREADS; i ++ ){
        int start = i * step;
        int end = (i == NUM_THREADS - 1) ? n : (i + 1) * step;
        futures[i] = promises[i].get_future(); // 获取关联的 future 对象
        threads[i] = std::thread(get_sum, std::ref(arr), start, end, std::ref(promises[i]));
    }

    // 等待每个结果，累加结果
    for(auto& res : futures){
        arr_sum += res.get();
    }

    // 等待线程完成
    for(auto& t : threads) t.join();

    // 计算终止时间点
    auto end_time = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double, std::milli> dura = end_time - start_time;
    std::cout << "spend time = " << dura.count() << "ms" << "\n";
    
    // 输出数组之和
    std::cout << "finally the sum = " << arr_sum << "\n";

    return 0;
}
```
std::atomic 原子操作的方法
```c++
#include <iostream>
#include <thread>
#include <atomic>
#include <vector>
#include <numeric>
#include <chrono>

const int NUM_THREADS = 24;
std::atomic<long long> arr_sum; // 共享数据变量，数组之和

// 线程接口函数
void get_sum(const std::vector<int>& arr, int start, int end){
    long long cur_sum = 0;
    for(size_t i = start; i < end; i ++ ){
        cur_sum += arr[i];
    }
    arr_sum += cur_sum; // 原子操作，无需加锁
}

int main(){
    // 数组数据输入
    const int n = 1e9;
    std::vector<int> arr(n);
    std::iota(begin(arr), end(arr), 0);

    // 计算起始时间点
    auto start_time = std::chrono::high_resolution_clock::now();

    // 创建多个线程
    const int step = n / NUM_THREADS; // 每个线程计算的块大小
    std::vector<std::thread> threads(NUM_THREADS);
    for(int i = 0; i < NUM_THREADS; i ++ ){
        int start = i * step;
        int end = (i == NUM_THREADS - 1) ? n : (i + 1) * step;
        threads[i] = std::thread(get_sum, std::ref(arr), start, end);
    }

    // 等待所有线程完成
    for(auto& t : threads) t.join();

    // 计算终止时间点
    auto end_time = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double, std::milli> dura = end_time - start_time;
    std::cout << "spend time = " << dura.count() << "ms." << "\n";
    
    // 输出数组之和
    std::cout << "finally the sum = " << arr_sum << "\n";

    return 0;
}
```
### 线程池
``` c++
#include <iostream>
#include <thread>
#include <mutex>
#include <future>
#include <condition_variable>
#include <functional>
#include <vector>
#include <queue>

class ThreadPool{
    void work(); // 线程执行的函数（任务内容）
    bool stop; // 线程池是否停止标记
    std::queue<std::function<void()>> tasks; // 任务队列，任务被包装为 void function
    std::vector<std::thread> threads; // 线程池
    std::condition_variable cv; // 条件变量，用于唤醒等待的线程
    std::mutex mtx; // 互斥量，用于互斥访问标记、任务队列
public:
    // 构造函数，传入线程池中线程数量
    ThreadPool(int thread_num); 

    // 析构函数
    ~ThreadPool();

    // 添加任务到任务队列函数，返回类型后置（参数：函数，可变参数模板）
    // 传入万能引用，返回一个 std::future 对象（获取结果为 std::result_of<F(Arg...)>::type）
    template<typename F, typename... Arg>
    auto submit(F&& f, Arg&&... args) -> std::future<typename std::result_of<F(Arg...)>::type>;
};

// 构造函数
ThreadPool::ThreadPool(int thread_num): stop(false) {
    for(size_t i = 0; i < thread_num; i ++ ){
        threads.emplace_back(&ThreadPool::work, this);
    }
}

// 析构函数
ThreadPool::~ThreadPool(){
    {
        std::lock_guard<std::mutex> lck(mtx); // 加锁，互斥访问 stop 标记
        stop = true;
    }

    // 通知所有等待中的线程，线程池已经停止
    cv.notify_all();

    // 等待所有子线程运行完毕
    for(auto& t : threads){
        if(t.joinable()){
            t.join();
        }
    }
}

// 提交任务函数
template<typename F, typename... Arg>
auto ThreadPool::submit(F&& f, Arg&&... args) -> std::future<typename std::result_of<F(Arg...)>::type>{
    // 执行 f 函数返回的数据类型
    using func_type = typename std::result_of<F(Arg...)>::type;

    // 通过智能指针，指向函数模板为 func_type() 的包装任务，避免共同访问时被销毁
    // 通过 std::bind 绑定函数、可变参数列表得到一个包装任务
    // std::forward 用于完美转发，将参数以原始的类型（左值或右值）传递
    auto task = std::make_shared<std::packaged_task<func_type()>>(
        std::bind(std::forward<F>(f), std::forward<Arg>(args)...)
    );

    // 添加任务到任务队列
    {
        std::lock_guard<std::mutex> lck(mtx);
        if(stop){
            throw std::runtime_error("ERROR: The thread pool is stoped.");
        }
        // 将前面构造好的可调用对象 packaged_task 添加任务队列
        tasks.emplace([task](){ // 捕获 task 智能指针
            (*task)(); // 解引用，获取指向的包装任务，并通过()调用这个任务
        });
    }

    // 唤醒一个等待的线程来执行任务
    cv.notify_one();

    // 返回 std::future 对象，后续等待获取结果
    return task -> get_future();
}

// 线程执行的函数
void ThreadPool::work(){
    while(true){
        // 定义一个任务
        std::function<void()> task;

        // 从任务队列中取出一个任务
        {
            std::unique_lock<std::mutex> lck(mtx);
            while(tasks.empty() && !stop){ // 避免虚假唤醒
                cv.wait(lck); // 需要等待任务进队，线程陷入阻塞
            }
            // 可能由于 stop 而退出上面的循环，此时若任务队列为空，直接返回
            if(tasks.empty() && stop){ // 任务队列为空且线程池停止
                return;
            }
            task = std::move(tasks.front());
            tasks.pop();
        }

        // 执行任务
        task();
    }
}

```

``` c++
#include <iostream>
#include <future>
#include <vector>
#include "Thread_Pool.cpp" // 引入线程池
using namespace std;

int main(){
    ThreadPool pool(4); // 创建一个有 4 个线程的线程池

    // 提交一些任务
    vector<pair<future<int>, int>> results; // 存储 future 对象及任务编号
    for(int i = 0; i < 12; i ++ ){
        // 提交任务后，得到 std::future 对象
        auto res = pool.submit([](int x){
            cout << "Task " << x << ": thread id = " << this_thread::get_id() << "\n";
            return x * x;
        }, i);
        results.emplace_back(move(res), i); // std::future 不可拷贝
    }

    // 获取结果
    for(auto& [res, id] : results){
        cout << "Task " << id << ": result = " << res.get() << "\n";
    }

    return 0;
}```
## 补充
### 构造函数

## 参考引用
1. [RALL]https://blog.csdn.net/weixin_45031801/article/details/142737361
2. [thread]https://marisamagic.github.io”