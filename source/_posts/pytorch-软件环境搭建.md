---
title: pytorch 软件环境搭建
date: 2024-08-29 15:00:08
tags: 
- Pytorch
categories: 
- 软件
---
# Pytorch 环境搭建
## conda安装
conda是一个开源的包、环境管理器，可以用于在同一个机器上安装不同版本的软件包及其依赖，并能够在不同的环境之间切换。我强烈推荐你使用他，他的作用类似于java中的maven和我们平时使用的虚拟机，他能够保证的项目之间互相是隔离的。举个简单的例子，如果你同时有两个项目，你一个使用的是pytorch1.8，一个用的是pytorch1.10，这样一个环境肯定就不够了，这个时候anaconda就派上大用场了，他可以创建两个环境，各用各的，互不影响，而且同过不同项目加载不同环境，也可以使项目加载更快更轻便。 

Anaconda有完整版和min版，完整版过于臃肿，因此推荐min版。下载地址推荐[清华大学开源镜像网站](https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/),如果不想自己挑选版本也可以点击这个链接下载楼主的版本[Miniconda3](https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-py39_4.9.2-Windows-x86_64.exe)  
不管下载那个版本的，请注意不要安装到C盘，这是因为conda的使用过程会占据大量内存，下载C盘会使得C盘内存紧张。 
安装的时候，需要添加到系统路径这个选项也请务必选上，后面使用起来会带来很多便捷，并且这里的安装位置请你一定要记得，后面我们在Pycharm中将会使用到。  

![conda安装选择](/pic/conda安装选择.png)  

## conda 虚拟环境创建
首先，我们要根据项目需求来创建一个环境，通过下面的指令创建并激活虚拟环境  
本文这里以Python版本3.8.5为例子进行创建一个名为Pytorch的虚拟环境  

`conda create -n Pytorch python==3.8.5`  
`conda activate Pytorch`  

![conda安装选择](/pic/进入虚拟环境.png)  

创建环境过程中需要下载，由于下载服务器不稳定，可能会出现下载错误。导致虚拟环境创建失败，创建成功后并进入虚拟环境，命令行出现Pytorch着表明环境创建成功。  
一定要出现“Pytorch”没出现着表面没进入虚拟环境，会导致后续安装的包的都在基础环境中。  

## Pytorch 安装
在安装Pytorch前需要缺确认电脑cuda驱动，cuda驱动不用自己安装，一般都随电脑自带的。可以在命令行中输入`nvidia-smi`  

![nvidia版本](/pic/nvidia.png)  

正常出现这个输出着证明cuda驱动没问题，我们还需要记住 CUDA version 版本。上面的截图的版本是12.6.  
后面pytorch安装需要更具你的cuda版本进行安装，cuda版本可以向下兼容，向上着会出现安装报错。  
安装有两个选择，一个是去[官网](https://pytorch.org/get-started/locally/)根据版本环境需求下载，但是由于服务器的原因下载并不稳定。本文后续介绍其它方法。

### Pytorch CPU版本安装
`conda install pytorch torchvision torchaudio cpuonly -c pytorch`
### Pytroch GPU版本安装
`conda install pytorch==1.12.0 torchvision==0.13.0 torchaudio==0.12.0 cudatoolkit=11.3 -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/pytorch/win-64/`
  

## Pycharm IED 安装
Pycharm IED是python集成编辑器，目前[Pycharm官网](https://www.jetbrains.com/pycharm/)有两个版本社区版和专业版。通常来说初学者使用[Pycharm社区版](https://download-cdn.jetbrains.com.cn/python/pycharm-community-2024.2.1.exe)完全够用。另外如想使用专业版，由于专业版有使用期限，但学生可以利用学生邮箱（edu后缀）去省钱使用，可以免费白嫖！！！  
安装Pycharm过程十分简单这里就过多赘述，仅建议安装过程在选择Pycharm需求时全选。
### conda 环境引入
![step1](/pic/pytorchstep1.png) 
![step2](/pic/pytorchstep2.png)  
## 验证
验证在Pycharm中新建一个项目，新建项目安装前一掌将conda引入。  
新建一个py文件并输入下面代码  
`import torch`  
`print(torch.__version__)`  
`print(torch.version.cuda)`  
`print(torch.cuda. is_available())`  

进行运行，输出结果如下
![检验结果](/pic/pytorch检验.png) 
## 完结撒花  
第一片技术类文章完结撒花，总耗时4小时
